require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { getTenantClient } = require("../src/config/tenantPrisma");
(async () => {
  const t = getTenantClient("restaurant_1");
  const s = await t.restaurantSetting.findUnique({ where: { restaurantId: 1 } });
  if (!s) { console.log("NO TENANT SETTING"); process.exit(0); }
  const pick = (k) => s[k];
  console.log(JSON.stringify({
    businessMode: pick("businessMode"), enablePosOrdering: pick("enablePosOrdering"), enableFloorManagement: pick("enableFloorManagement"),
    enableMergeTables: pick("enableMergeTables"), enableActiveOrders: pick("enableActiveOrders"), enableKitchen: pick("enableKitchen"),
    posLayout: pick("posLayout"), enableCounterSale: pick("enableCounterSale"), autoGenerateKOT: pick("autoGenerateKOT"), autoPrintKOT: pick("autoPrintKOT"),
    taxType: pick("taxType"), enableSplitBill: pick("enableSplitBill")
  }, null, 1));
  await t.$disconnect?.(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
