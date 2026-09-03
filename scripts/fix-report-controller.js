const fs = require('fs');

let code = fs.readFileSync('src/controllers/report.controller.js', 'utf8');

// Fix the import — remove old prisma reference
code = code.replace(
  /const prisma = require\("\.\.\/config\/prisma"\);/,
  'const { platformPrisma } = require("../config/tenantPrisma");'
);

// Fix resolveRestaurantId to use platformPrisma
code = code.replace(
  'const firstRestaurant = await prisma.restaurant.findFirst',
  'const firstRestaurant = await platformPrisma.restaurant.findFirst'
);

// Now we need to add req.tenantDb to all service calls.
// Each handler already has `req` in scope.
// The pattern is: these handler functions use `const restaurantId = await resolveRestaurantId(req);`
// We need to also get tenantDb and pass it.

// Add tenantDb resolution helper after resolveRestaurantId
const helperCode = `
function resolveTenantDb(req, restaurantId) {
  // For restaurant users, req.tenantDb is already set by auth middleware
  if (req.tenantDb && req.user.restaurantId === restaurantId) {
    return req.tenantDb;
  }
  // For SUPER_ADMIN, we can't resolve tenant without restaurantId
  return req.tenantDb || null;
}
`;

// Insert helper after resolveRestaurantId function closing
code = code.replace(
  'function getQueryParams(req) {',
  helperCode + '\nfunction getQueryParams(req) {'
);

// Now add `const tenantDb = resolveTenantDb(req, restaurantId);` after each `const restaurantId = await resolveRestaurantId(req);`
// and add `, tenantDb` to each service call

// First, add tenantDb resolution after each restaurantId resolution
code = code.replace(
  /const restaurantId = await resolveRestaurantId\(req\);/g,
  'const restaurantId = await resolveRestaurantId(req);\n    const tenantDb = resolveTenantDb(req, restaurantId);'
);

// Now add , tenantDb to each service function call.
// These functions are: getSalesReport, getItemSalesReport, getCategorySalesReport, getPaymentReport,
// getOrderReport, getRevenueTrend, getSalesBills, getDailyReport,
// getHourlySalesReport, getSalesComparisonReport, getDiscountReport, getCancellationReport,
// getKotRegister, getKotSummary, getKitchenPerformance, getMenuPerformance,
// getTopSellingItems, getLowSellingItems, getCategoryPerformance, getTableSales,
// getTableOccupancy, getStaffSales, getStaffActivity, getStaffDiscountCancellation,
// getDailyClosing, getMonthlySummary, getRestaurantPerformance

const serviceFunctions = [
  'getSalesReport', 'getItemSalesReport', 'getCategorySalesReport', 'getPaymentReport',
  'getOrderReport', 'getRevenueTrend', 'getSalesBills', 'getDailyReport',
  'getHourlySalesReport', 'getSalesComparisonReport', 'getDiscountReport', 'getCancellationReport',
  'getKotRegister', 'getKotSummary', 'getKitchenPerformance', 'getMenuPerformance',
  'getTopSellingItems', 'getLowSellingItems', 'getCategoryPerformance', 'getTableSales',
  'getTableOccupancy', 'getStaffSales', 'getStaffActivity', 'getStaffDiscountCancellation',
  'getDailyClosing', 'getMonthlySummary', 'getRestaurantPerformance'
];

for (const fn of serviceFunctions) {
  // Match function call and add tenantDb as last param
  // Handle both single-line and multi-line calls
  // Pattern: await functionName(...)
  // We need to add , tenantDb before the closing )
  
  // Single line: await fn(args);
  const singleLine = new RegExp(`await ${fn}\\(([^)]+)\\);`, 'g');
  code = code.replace(singleLine, (match, args) => {
    if (args.includes('tenantDb')) return match; // already added
    return `await ${fn}(${args}, tenantDb);`;
  });
  
  // Multi-line for getOrderReport which spans multiple lines
  // getSalesComparisonReport also has many params
}

fs.writeFileSync('src/controllers/report.controller.js', code);
console.log('report.controller.js updated');
