/**
 * Dietary access enforcement (Parts 5/9/10/15).
 *
 * The EFFECTIVE dietary access is a hierarchy (Part 5):
 *
 *   RestaurantSetting.dietaryMode   ← upper boundary (restaurant-wide maximum)
 *   + User.dietaryAccess            ← individual staff setting
 *
 *   Restaurant VEG_ONLY        → EVERYONE is effectively VEG_ONLY, even a
 *                                staff member with dietaryAccess=VEG_AND_NON_VEG.
 *   Restaurant VEG_AND_NON_VEG → the staff setting applies.
 *
 * Enforced server-side (never only in React):
 *   - GET /api/menu filters out NON_VEG items for effectively-VEG_ONLY users,
 *   - order creation / item-add / item-update reject a NON_VEG menuItemId
 *     with 400 "This staff account can only access vegetarian items.",
 *   - menu create/update cannot create NON_VEG items in a VEG_ONLY restaurant.
 */
const { effectiveDietaryAccess } = require("./permissions");

const DIETARY_BLOCKED_MESSAGE = "This staff account can only access vegetarian items.";

/**
 * Resolve the restaurant's dietary mode from its settings row.
 * Missing/NULL/unknown → VEG_AND_NON_VEG (existing restaurants keep behavior).
 */
function restaurantDietaryMode(setting) {
  return setting && setting.dietaryMode === "VEG_ONLY" ? "VEG_ONLY" : "VEG_AND_NON_VEG";
}

/**
 * Resolve the user's own dietary access from the authenticated user row.
 * ADMIN (public plane) defaults to full access — Part 9/21.
 */
function userDietaryAccess(req) {
  return effectiveDietaryAccess(req.user);
}

/**
 * EFFECTIVE dietary access = restaurant mode ∩ user access (Part 5/15).
 * The restaurant is the ceiling: it can only ever restrict further.
 *
 * @param {object} req      authenticated request
 * @param {object} setting  tenant RestaurantSetting row (may be null)
 * @returns {"VEG_ONLY"|"VEG_AND_NON_VEG"}
 */
function effectiveDietaryAccessFor(req, setting) {
  if (restaurantDietaryMode(setting) === "VEG_ONLY") return "VEG_ONLY";
  return userDietaryAccess(req);
}

/**
 * Async resolver used by controllers: loads the caller's restaurant settings
 * from the TENANT schema (req.tenantDb — never a client-supplied schema) and
 * computes the effective access.
 */
async function requesterDietaryAccess(req) {
  const userAccess = userDietaryAccess(req);
  if (userAccess === "VEG_ONLY") return "VEG_ONLY"; // restaurant can only restrict further
  try {
    if (req.tenantDb && req.user && req.user.restaurantId) {
      const setting = await req.tenantDb.restaurantSetting.findUnique({
        where: { restaurantId: req.user.restaurantId },
        select: { dietaryMode: true },
      });
      return restaurantDietaryMode(setting) === "VEG_ONLY" ? "VEG_ONLY" : userAccess;
    }
  } catch (err) {
    // Fail OPEN to the user's own access on a settings-read error — never
    // stronger than the user's personal setting, and existing behavior is
    // preserved when the column/table is not yet migrated.
    console.warn("[dietary] settings read failed, falling back to user access:", err.message);
  }
  return userAccess;
}

/**
 * Prisma `where` fragment for menu queries so a effectively-VEG_ONLY user can
 * never receive NON_VEG items. VEG_AND_NON_VEG adds no constraint.
 */
async function dietaryMenuWhere(req) {
  return (await requesterDietaryAccess(req)) === "VEG_ONLY" ? { dietaryType: "VEG" } : {};
}

/**
 * Guard a single menu item for dietary access (orders).
 * Returns null when allowed, otherwise the rejection message (400).
 */
async function dietaryItemError(req, menuItem) {
  if (!menuItem) return null;
  const access = await requesterDietaryAccess(req);
  if (access === "VEG_ONLY" && menuItem.dietaryType === "NON_VEG") {
    return DIETARY_BLOCKED_MESSAGE;
  }
  return null;
}

module.exports = {
  DIETARY_BLOCKED_MESSAGE,
  restaurantDietaryMode,
  effectiveDietaryAccessFor,
  requesterDietaryAccess,
  dietaryMenuWhere,
  dietaryItemError,
};
