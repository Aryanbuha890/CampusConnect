// =============================================================================
// Edge Function: Create Stripe Checkout Session (with Group Discounts)
// Issue: #2902 - Implement 'Group Discounts' for Event Ticketing
// Description: Creates a Stripe Checkout session. Validates the requested
// quantity against remaining capacity, calculates the group discount, and
// applies it as a negative line item (discount) in the Stripe session.
    // =============================================================================

    import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@13.0.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
    apiVersion: "2023-10-16",
});

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DiscountRule {
    min_qty: number;
    discount_pct: number;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        // 1. Authenticate User
        const authHeader = req.headers.get("Authorization")!;
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL") ?? "",
            Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            { global: { headers: { Authorization: authHeader } } }
        );
        const adminSupabase = createClient(
            Deno.env.get("SUPABASE_URL") ?? "",
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        );

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Unauthorized");

        // 2. Parse Request
        const { eventId, quantity, tierName } = await req.json();
        if (!eventId || !quantity || quantity < 1) {
            throw new Error("Invalid event ID or quantity");
        }

        // 3. Fetch Event to check for JSON ticket tiers
        const { data: event, error: eventError } = await adminSupabase
            .from("events")
            .select("title, ticket_tiers")
            .eq("id", eventId)
            .single();

        if (eventError || !event) {
            throw new Error("Event not found");
        }

        const jsonTiers = event.ticket_tiers;
        const hasJsonTiers = jsonTiers && Array.isArray(jsonTiers) && jsonTiers.length > 0;

        let basePriceCents = 0;
        let lineItemName = "";
        let rsvpId = null;
        let tier = null;
        let tierPayment = null;

        if (hasJsonTiers) {
            if (!tierName) {
                throw new Error("tierName is required for this event");
            }

            const requestedTier = jsonTiers.find((t: any) => t.name === tierName);
            if (!requestedTier) {
                throw new Error(`Ticket tier ${tierName} not found`);
            }

            basePriceCents = Math.round(requestedTier.price * 100);
            lineItemName = `${event.title} - ${tierName}`;

            // Concurrency-safe reservation
            const { data, error: reserveError } = await adminSupabase.rpc("check_and_reserve_ticket_tier", {
                p_event_id: eventId,
                p_tier_name: tierName,
                p_quantity: quantity,
                p_user_id: user.id
            });

            if (reserveError || !data) {
                throw new Error(reserveError?.message || "Ticket tier is sold out.");
            }
            rsvpId = data;
        } else {
            // Standard ticket tier logic
            const { data: activeTiers, error: tierError } = await supabase.rpc('get_active_ticket_tier', {
                p_event_id: eventId
            });

            if (tierError || !activeTiers || activeTiers.length === 0) {
                throw new Error("No ticket tier is currently available");
            }

            tier = activeTiers[0];
            const remainingCapacity = tier.capacity !== null ? tier.capacity - tier.sold_count : Infinity;

            if (quantity > remainingCapacity) {
                throw new Error(`Only ${remainingCapacity} tickets remaining for the current tier.`);
            }

            basePriceCents = tier.price;
            lineItemName = `${event.title} - ${tier.name}`;

            const { data: tp } = await adminSupabase
                .from("ticket_tiers")
                .select("stripe_price_id")
                .eq("id", tier.id)
                .maybeSingle();
            tierPayment = tp;
        }

        const { data: activeFlashSale } = await adminSupabase
            .from("event_flash_sales")
            .select("id, sale_price_cents, sale_stripe_price_id, discount_percent, expires_at")
            .eq("event_id", eventId)
            .eq("status", "active")
            .gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        // 4. Calculate Discount. Flash sales are deliberately not stackable
        // with group discounts so the organizer's advertised price is exact.
        const rules: DiscountRule[] = activeFlashSale ? [] : (tier ? (tier.discount_rules || []) : []);
        const sortedRules = [...rules].sort((a, b) => b.min_qty - a.min_qty);

        let applicableDiscount = 0;
        for (const rule of sortedRules) {
            if (quantity >= rule.min_qty) {
                applicableDiscount = rule.discount_pct;
                break;
            }
        }

        // Check if dynamic pricing is active on this event
        const { data: eventDetails, error: eventDetailsError } = await supabase
            .from("events")
            .select("base_price, surge_multiplier")
            .eq("id", eventId)
            .single();

        let isDynamic = false;
        if (!hasJsonTiers && !eventDetailsError && eventDetails && eventDetails.base_price !== null) {
            const { data: dynamicPrice, error: priceError } = await supabase.rpc('calculate_current_price', {
                p_event_id: eventId
            });
            if (!priceError && dynamicPrice !== null) {
                basePriceCents = dynamicPrice;
                isDynamic = true;
            }
        }

        if (activeFlashSale) basePriceCents = activeFlashSale.sale_price_cents;

        const subtotal = basePriceCents * quantity;
        const discountAmount = Math.round(subtotal * (applicableDiscount / 100));
        const totalAmount = subtotal - discountAmount;

        // 5. Build Stripe Line Items. A sale Price is resolved only on the
        // server; the browser never supplies an amount or Stripe Price ID.
        const activeStripePriceId = activeFlashSale?.sale_stripe_price_id || tierPayment?.stripe_price_id;
        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = activeStripePriceId
            ? [{ price: activeStripePriceId, quantity }]
            : [{
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: activeFlashSale
                            ? `${event.title} (Flash Sale)`
                            : isDynamic
                                ? `${event.title} (Dynamic Price)`
                                : lineItemName,
                        description: `${quantity} ticket(s)`,
                    },
                    unit_amount: basePriceCents,
                },
                quantity,
            }];

        // Apply discount as a negative line item if applicable
        if (discountAmount > 0) {
            lineItems.push({
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: `Group Discount (${applicableDiscount}% off)`,
                    },
                    unit_amount: -discountAmount, // Negative amount for discount
                },
                quantity: 1,
            });
        }

        // 6. Create Stripe Checkout Session
        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ["card"],
                line_items: lineItems,
                mode: "payment",
                success_url: `${req.headers.get("origin")}/events/${eventId}/tickets/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${req.headers.get("origin")}/events/${eventId}/tickets`,
                metadata: {
                    user_id: user.id,
                    tier_id: tier ? tier.id : "",
                    tier_name: hasJsonTiers ? tierName : "",
                    quantity: quantity.toString(),
                    discount_applied: applicableDiscount.toString(),
                    flash_sale_id: activeFlashSale?.id || "",
                    flash_sale_discount: activeFlashSale?.discount_percent?.toString() || "",
                    event_id: eventId,
                    rsvp_id: rsvpId || ""
                },
                // Enforce "All or Nothing" refund policy for group purchases
                payment_intent_data: {
                    setup_future_usage: 'off_session',
                }
            });

            return new Response(
                JSON.stringify({ sessionId: session.id, url: session.url }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
            );
        } catch (stripeErr) {
            if (rsvpId) {
                // Roll back the reservation if Stripe session creation fails
                await adminSupabase.from("event_rsvps").delete().eq("id", rsvpId);
            }
            throw stripeErr;
        }

    } catch (error: any) {
        console.error("[StripeCheckout] Error:", error);
        return new Response(
            JSON.stringify({ error: error.message }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
        );
    }
});
