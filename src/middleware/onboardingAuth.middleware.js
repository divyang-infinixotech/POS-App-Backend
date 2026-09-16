const jwt = require("jsonwebtoken");
const { platformPrisma: prisma } = require("../config/tenantPrisma");

/**
 * Authentication for the self-serve onboarding endpoints (/api/onboarding/*).
 *
 * The normal POS `protect` middleware refuses every non-ACTIVE restaurant, so
 * applicants could never resume their registration with it. This middleware
 * authenticates the applicant ADMIN (public.User) WITHOUT granting any POS
 * access — it only proves "this JWT belongs to the ADMIN of this in-progress
 * self-serve application". Standard `protect` still guards every POS route, so
 * an onboarding account can never reach restaurant operations before ACTIVE.
 *
 * Attaches:
 *   req.onboarding = { user, restaurant|null }
 *   req.onboardingRestaurant = restaurant|null  (convenience)
 */
const onboardingAuth = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }
  if (!token && req.query.token) token = req.query.token;
  if (!token) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { restaurant: true },
    });

    if (!user || user.deletedAt) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.role !== "ADMIN") {
      // SUPER_ADMIN + tenant staff have no business here — SUPER_ADMIN reviews
      // applications through the /super-admin endpoints.
      return res.status(403).json({
        success: false,
        message: "This area is only available to restaurant onboarding accounts.",
      });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: "Your account has been disabled." });
    }

    // Password changed → old tokens are invalid (same rule as POS protect).
    if (user.passwordChangedAt) {
      const changedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
      if (decoded.iat && changedAtSec > decoded.iat) {
        return res.status(401).json({
          success: false,
          message: "Your password was changed. Please log in again.",
        });
      }
    }

    // Resolve the application from the DATABASE relationship — never from the
    // JWT alone (the JWT restaurantId is only a context hint and can never
    // select a different restaurant than the one the user row points to).
    const restaurant = user.restaurantId ? user.restaurant : null;
    if (user.restaurantId && !restaurant) {
      return res.status(403).json({ success: false, message: "Restaurant not found." });
    }
    if (restaurant && !restaurant.selfServe) {
      return res.status(403).json({
        success: false,
        message: "This account is not a self-serve onboarding application.",
      });
    }

    req.onboarding = {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, restaurantId: user.restaurantId || null },
      restaurant,
    };
    req.onboardingRestaurant = restaurant;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};

module.exports = onboardingAuth;
