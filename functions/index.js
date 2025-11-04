/**
 * Firebase Cloud Function to handle PayPal Webhook events for Meno-Guide Subscriptions.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const paypal = require("@paypal/checkout-server-sdk");

// Initialize Firebase Admin SDK (run 'firebase functions:config:set paypal.client_id="YOUR_PAYPAL_LIVE_CLIENT_ID" paypal.client_secret="YOUR_PAYPAL_LIVE_SECRET" paypal.webhook_id="YOUR_PAYPAL_LIVE_WEBHOOK_ID"' in your terminal)
// For testing, you can use sandbox credentials: 'firebase functions:config:set paypal.sandbox_client_id="..." paypal.sandbox_client_secret="..." paypal.sandbox_webhook_id="..."'
admin.initializeApp();
const db = admin.firestore();

// --- PayPal Environment Setup ---
// Determine if we should use Sandbox or Live based on configuration (or default to Sandbox if not set)
// IMPORTANT: Set these environment variables in Firebase Functions config
const environment = process.env.NODE_ENV === "production" ?
    new paypal.core.LiveEnvironment(
        functions.config().paypal.client_id,
        functions.config().paypal.client_secret
    ) :
    new paypal.core.SandboxEnvironment(
        functions.config().paypal.sandbox_client_id || functions.config().paypal.client_id, // Fallback to live if sandbox not set
        functions.config().paypal.sandbox_client_secret || functions.config().paypal.client_secret
    );
const client = new paypal.core.PayPalHttpClient(environment);
const webhookId = process.env.NODE_ENV === "production" ?
    functions.config().paypal.webhook_id :
    functions.config().paypal.sandbox_webhook_id || functions.config().paypal.webhook_id; // Fallback to live webhook ID if sandbox not set


// --- Main Webhook Handler Function ---
exports.paypalWebhookHandler = functions.https.onRequest(async (req, res) => {
    // Check if it's a POST request
    if (req.method !== "POST") {
        functions.logger.warn("Received non-POST request");
        return res.status(405).send("Method Not Allowed");
    }

    // --- Verify the Webhook Signature ---
    // This is crucial for security to ensure the request is genuinely from PayPal
    const transmissionId = req.headers["paypal-transmission-id"];
    const transmissionTime = req.headers["paypal-transmission-time"];
    const certUrl = req.headers["paypal-cert-url"];
    const authAlgo = req.headers["paypal-auth-algo"];
    const transmissionSig = req.headers["paypal-transmission-sig"];
    const requestBody = req.rawBody; // Use rawBody for verification

    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig || !requestBody || !webhookId) {
        functions.logger.error("Missing PayPal headers or webhook ID for verification.");
        return res.status(400).send("Verification headers missing.");
    }

    const verificationRequest = new paypal.webhooks.VerifyWebhookSignatureRequest();
    verificationRequest.transmissionId(transmissionId);
    verificationRequest.transmissionTime(transmissionTime);
    verificationRequest.certUrl(certUrl);
    verificationRequest.authAlgo(authAlgo);
    verificationRequest.transmissionSig(transmissionSig);
    verificationRequest.webhookId(webhookId); // Your Webhook ID from PayPal dashboard
    verificationRequest.webhookEvent(JSON.parse(requestBody.toString('utf8'))); // Pass the parsed body

    try {
        const verificationResponse = await client.execute(verificationRequest);
        functions.logger.info("Webhook Verification Response:", verificationResponse);

        if (verificationResponse.result.verification_status !== "SUCCESS") {
            functions.logger.error("Webhook verification failed:", verificationResponse.result);
            return res.status(400).send("Webhook verification failed.");
        }
        functions.logger.info("Webhook verification successful.");

    } catch (err) {
        functions.logger.error("Error verifying webhook signature:", err.message, err.statusCode, err.headers);
        if (err.statusCode) {
             functions.logger.error("Error details:", JSON.stringify(err._originalError?.message || err.message));
        }
        return res.status(500).send("Error verifying webhook.");
    }

    // --- Process the Verified Event ---
    const event = req.body; // Now use the parsed body
    functions.logger.info("Received PayPal Event:", JSON.stringify(event));

    const eventType = event.event_type;
    const resource = event.resource;

    // --- Extract Firebase User ID ---
    // We expect the custom_id field on the subscription resource to hold our Firebase UID
    const firebaseUserId = resource.custom_id;
    if (!firebaseUserId) {
        functions.logger.error(`Event type ${eventType} received, but no custom_id (Firebase User ID) found on resource.`, resource);
        // Acknowledge receipt even if we can't process, to prevent PayPal retries
        return res.status(200).send("Event received but missing user identifier.");
    }
    functions.logger.info(`Processing event ${eventType} for Firebase User ID: ${firebaseUserId}`);

    const userDocRef = db.collection("users").doc(firebaseUserId);
    let subscriptionUpdate = {};
    let planName = 'Unknown Plan'; // Default
    let status = 'unknown';

    // Determine plan name based on plan_id if available (useful for activation)
     if (resource.plan_id) {
        if (resource.plan_id === (process.env.NODE_ENV === "production" ? functions.config().paypal.live_plan_monthly : functions.config().paypal.sandbox_plan_monthly || functions.config().paypal.live_plan_monthly)) planName = 'Pro Plan (Monthly)';
        else if (resource.plan_id === (process.env.NODE_ENV === "production" ? functions.config().paypal.live_plan_yearly : functions.config().paypal.sandbox_plan_yearly || functions.config().paypal.live_plan_yearly)) planName = 'Pro Plan (Yearly)';
        else if (resource.plan_id === (process.env.NODE_ENV === "production" ? functions.config().paypal.live_plan_trial : functions.config().paypal.sandbox_plan_trial || functions.config().paypal.live_plan_trial)) planName = 'Pro Trial';
     }

    // --- Handle Different Event Types ---
    switch (eventType) {
        case "BILLING.SUBSCRIPTION.ACTIVATED":
        case "PAYMENT.SALE.COMPLETED": // Often follows ACTIVATED, especially after trial
             // Check if it's related to a subscription
            if (resource.billing_agreement_id || resource.id?.startsWith('I-')) { // resource.id check for subscription payments
                status = 'active';
                // Estimate next billing date if possible (PayPal doesn't always provide it easily in all events)
                // For simplicity, we'll just mark as active. Validity update might need more logic
                // or rely on fetching subscription details.
                subscriptionUpdate = {
                    "subscription.status": status,
                    // Optionally update plan name if this event has plan_id
                    ...(resource.plan_id && { "subscription.plan": planName }),
                    // "subscription.validity": "New Expiry Date" // More complex to calculate accurately here
                };
                functions.logger.info(`Subscription ${resource.id || resource.billing_agreement_id} activated or payment completed for user ${firebaseUserId}. Updating status to active.`);
            } else {
                 functions.logger.info(`Received PAYMENT.SALE.COMPLETED event not related to a subscription for user ${firebaseUserId}. Ignoring.`);
                 return res.status(200).send("Event received but not a subscription payment.");
            }
            break;

        case "BILLING.SUBSCRIPTION.CANCELLED":
            status = 'cancelled';
            subscriptionUpdate = {
                "subscription.status": status,
                "subscription.validity": "Cancelled"
            };
            functions.logger.info(`Subscription ${resource.id} cancelled for user ${firebaseUserId}. Updating status.`);
            break;

        case "BILLING.SUBSCRIPTION.SUSPENDED":
        case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
            status = 'payment_failed'; // Or 'suspended'
            subscriptionUpdate = {
                "subscription.status": status,
                "subscription.validity": "Payment Issue"
            };
            functions.logger.warn(`Subscription ${resource.id} suspended or payment failed for user ${firebaseUserId}. Updating status.`);
            break;

        // Add other event types as needed (e.g., BILLING.SUBSCRIPTION.EXPIRED, BILLING.SUBSCRIPTION.UPDATED)

        default:
            functions.logger.info(`Unhandled event type: ${eventType}. Ignoring.`);
            return res.status(200).send("Unhandled event type.");
    }

    // --- Update Firestore ---
    try {
        await userDocRef.update(subscriptionUpdate);
        functions.logger.info(`Successfully updated Firestore for user ${firebaseUserId} with status ${status}.`);
        // Return 200 OK to PayPal to acknowledge receipt
        return res.status(200).send("Webhook processed successfully.");
    } catch (error) {
        functions.logger.error(`Error updating Firestore for user ${firebaseUserId}:`, error);
        // Return 500 to signal an error, PayPal might retry
        return res.status(500).send("Error updating database.");
    }
});

