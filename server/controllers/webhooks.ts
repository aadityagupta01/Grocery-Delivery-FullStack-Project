import { Request, Response } from "express";
import Stripe from "stripe";
import { prisma } from "../config/prisma.js";
import { inngest } from "../inngest/index.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Derived from the SDK itself, so we don't depend on the `Stripe.Event`
// namespace type that TypeScript 6 fails to resolve (StripeConstructor error).
type StripeEvent = ReturnType<typeof stripe.webhooks.constructEvent>;

export const stripeWebhook = async (request: Request, response: Response) => {
    if (!endpointSecret) {
        console.error("STRIPE_WEBHOOK_SECRET is not set.");
        return response.sendStatus(500);
    }

    // Get the signature sent by Stripe
    const signature = request.headers["stripe-signature"];
    if (!signature) {
        return response.sendStatus(400);
    }

    let event: StripeEvent;
    try {
        // request.body must be the RAW body (express.raw) for this to work
        event = stripe.webhooks.constructEvent(
            request.body,
            signature as string,
            endpointSecret
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.log(`⚠️ Webhook signature verification failed.`, message);
        return response.sendStatus(400);
    }

    try {
        // Handle the event
        switch (event.type) {
            case "payment_intent.succeeded": {
                // Narrowed automatically from event.type, no cast needed
                const paymentIntent = event.data.object;
                const paymentIntentId = paymentIntent.id;

                // Getting Session Metadata
                const session = await stripe.checkout.sessions.list({
                    payment_intent: paymentIntentId,
                });
                const orderId = session.data[0]?.metadata?.orderId;

                if (!orderId) {
                    // Nothing we can act on; acknowledge so Stripe doesn't keep retrying
                    console.log(`No orderId found for payment intent ${paymentIntentId}`);
                    break;
                }

                const existingOrder = await prisma.order.findUnique({
                    where: { id: orderId },
                });

                if (!existingOrder) {
                    console.log(`Order ${orderId} not found`);
                    break;
                }

                // Idempotency: Stripe may deliver the same event more than once
                if (existingOrder.isPaid) {
                    console.log(`Order ${orderId} already marked as paid`);
                    break;
                }

                const orderItems = (
                    Array.isArray(existingOrder.items) ? existingOrder.items : []
                ) as any[];

                // Mark as paid and decrease stock atomically
                await prisma.$transaction([
                    prisma.order.update({
                        where: { id: orderId },
                        data: { isPaid: true },
                    }),
                    ...orderItems.map((item) =>
                        prisma.product.update({
                            where: { id: item.product },
                            data: { stock: { decrement: item.quantity } },
                        })
                    ),
                ]);

                await inngest.send({ name: "order/placed", data: { orderId } });

                // Send stock update events for each product in the order
                for (const item of orderItems) {
                    await inngest.send({
                        name: "inventory/stock.updated",
                        data: { productId: item.product },
                    });
                }
                break;
            }

            case "payment_intent.canceled":
            case "payment_intent.payment_failed": {
                const paymentIntentFailure = event.data.object;
                const paymentIntentFailureId = paymentIntentFailure.id;

                // Getting Session Metadata
                const sessionFailure = await stripe.checkout.sessions.list({
                    payment_intent: paymentIntentFailureId,
                });

                const failureOrderId = sessionFailure.data[0]?.metadata?.orderId;

                if (!failureOrderId) {
                    console.log(
                        `No orderId found for payment intent ${paymentIntentFailureId}`
                    );
                    break;
                }

                // deleteMany doesn't throw if the order is already gone,
                // and the isPaid filter protects orders that were already paid
                await prisma.order.deleteMany({
                    where: { id: failureOrderId, isPaid: false },
                });
                break;
            }

            default:
                console.log(`Unhandled event type ${event.type}`);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`Error handling webhook event ${event.type}:`, message);
        // Non-2xx tells Stripe to retry later
        return response.sendStatus(500);
    }

    // Return a response to acknowledge receipt of the event
    return response.json({ received: true });
};