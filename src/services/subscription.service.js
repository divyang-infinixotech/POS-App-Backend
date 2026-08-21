/**
 * Subscription service — thin wrapper around the DB-driven subscription logic
 * shared with the Super Admin portal. No hardcoded plan configuration.
 */
const {
  changeSubscriptionPlan,
  renewSubscription,
} = require("./super-admin.service");

const upgradeSubscription = async (restaurantId, planId, userId, opts = {}) =>
  changeSubscriptionPlan(restaurantId, { ...opts, planId, action: "upgrade" }, userId);

const renewPlan = async (restaurantId, userId) => renewSubscription(restaurantId, userId);

module.exports = {
  upgradeSubscription,
  renewSubscription: renewPlan,
};
