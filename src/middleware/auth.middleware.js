const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

/**
 * Subscription self-service paths the ADMIN still needs when the subscription
 * has expired (view own snapshot, plans, checkout, verify, payment history,
 * gateway readiness, scheduled-downgrade cleanup). /auth/profile is included
 * so the frontend can rehydrate the expired snapshot on app boot. Everything
 * else stays blocked for an expired subscription.
 */
function isSubscriptionSelfServiceRoute(url) {
  // Strip the query string — req.originalUrl keeps it, so an exemption like
  // `/subscriptions/plans?cycle=MONTHLY` must still match `plans`.
  const path = String(url || "").split("?")[0];
  if (/^\/api\/auth\/profile$/.test(path)) return true;
  return /^\/api\/subscriptions\/(me|refresh|plans|gateway-status|payments|checkout|verify|downgrade)($|\/)/.test(path);
}

const protect = async (req, res, next) => {

    let token;

    // Check Authorization header first
    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer")
    ) {
        token = req.headers.authorization.split(" ")[1];
    }

    // Fallback: check query param (for receipt/invoice PDF downloads via window.open)
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({
            success: false,
            message: "No token provided"
        });
    }

    try {

        const decoded = jwt.verify(

            token,

            process.env.JWT_SECRET

        );

        const user = await prisma.user.findUnique({

            where: {

                id: decoded.id

            },

            include: {

                restaurant: true

            }

        });

        if (!user) {

            return res.status(404).json({

                success: false,

                message: "User not found"

            });

        }

        if (!user.isActive) {

            return res.status(403).json({

                success: false,

                message: "Your account has been disabled."

            });

        }

        // If the user changed their password, invalidate every token issued before that moment.
        // This makes "force logout after password change" work server-side, not just client-side.
        if (user.passwordChangedAt) {

            // Compare at SECOND precision on both sides: passwordChangedAt carries
            // milliseconds while the JWT iat is truncated to whole seconds. Comparing
            // the raw float against iat would falsely reject a token issued in the
            // SAME second as the password change (e.g. a fresh login immediately
            // after changing the password) — a real logout loop. Flooring both
            // sides keeps the intent (tokens from a strictly earlier second die)
            // while never rejecting a token from the same second or later.
            const changedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);

            if (decoded.iat && changedAtSec > decoded.iat) {

                return res.status(401).json({

                    success: false,

                    message: "Your password was changed. Please log in again."

                });

            }

        }

        // if (!user.restaurant) {

        //     return res.status(403).json({

        //         success: false,

        //         message: "Restaurant not found."

        //     });

        // }

        // if (user.restaurant.status !== "ACTIVE") {

        //     return res.status(403).json({

        //         success: false,

        //         message: "Restaurant account is suspended or inactive."

        //     });

        // }
        // Super Admin does not belong to any restaurant
// Skip restaurant validation for SUPER_ADMIN

if (

    user.role !== "SUPER_ADMIN" &&

    !user.restaurant

) {

    return res.status(403).json({

        success: false,

        message: "Restaurant not found."

    });

}

if (

    user.role !== "SUPER_ADMIN" &&

    user.restaurant.status !== "ACTIVE"

) {

    return res.status(403).json({

        success: false,

        message: "Your restaurant account is " + user.restaurant.status.toLowerCase() + ". Contact your Super Admin."

    });

}

// Subscription gate: expired / cancelled / suspended subscriptions block API
// access. The subscription SELF-SERVICE routes (view plans, checkout, verify,
// payment history) stay reachable when EXPIRED so the restaurant ADMIN can
// renew/purchase — the POS itself remains blocked everywhere else.
// Lightweight query (no planDef join) — this runs on every request for restaurant users.
if (user.role !== "SUPER_ADMIN" && user.restaurantId) {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { restaurantId: user.restaurantId },
      select: { status: true, expiryDate: true },
    });
    let subStatus = subscription ? subscription.status : null;
    // Logical expiry — blocks immediately after expiry, before the cron persists EXPIRED
    if (subscription && (subStatus === "ACTIVE" || subStatus === "TRIAL") && subscription.expiryDate && subscription.expiryDate < new Date()) {
      subStatus = "EXPIRED";
    }
    const blocked =
      !subscription ||
      subStatus === "CANCELLED" ||
      subStatus === "SUSPENDED" ||
      (subStatus === "EXPIRED" && !isSubscriptionSelfServiceRoute(req.originalUrl || req.url));
    if (blocked) {
      const reason = !subscription
        ? "No subscription found for your restaurant. Contact your Super Admin."
        : subStatus === "EXPIRED"
          ? "Your subscription has expired. Please renew to continue."
          : subStatus === "CANCELLED"
            ? "Your subscription has been cancelled. Contact support to renew."
            : "Your subscription is suspended. Contact support to reactivate.";
      return res.status(403).json({ success: false, message: reason });
    }
  } catch (err) {
    // fail-open only if subscription data cannot be resolved (never block on infra errors)
  }
}

        req.user = {

            id: user.id,

    restaurantId: user.restaurantId || null,

    role: user.role,

    name: user.name,

    email: user.email

        };

        next();

    }

    catch (error) {

        return res.status(401).json({

            success: false,

            message: "Invalid token"

        });

    }

};

module.exports = protect;