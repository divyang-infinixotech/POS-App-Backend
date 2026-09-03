const fs = require('fs');

// Fix report.service.js
let code = fs.readFileSync('src/services/report.service.js', 'utf8');

// The service now imports platformPrisma. We need each DB-querying function
// to accept a `db` parameter and use `const prisma = db || platformPrisma;`

// Strategy: replace each function signature to add `db` param,
// and inject `const prisma = db || platformPrisma;` as first line.

const serviceFixes = {
  'src/services/report.service.js': [
    { sig: 'async function getPaidSalesItems(restaurantId, from, to)', rep: 'async function getPaidSalesItems(restaurantId, from, to, db)' },
    { sig: 'const getSalesReport = async (restaurantId, from, to) =>', rep: 'const getSalesReport = async (restaurantId, from, to, db) =>' },
    { sig: 'const getItemSalesReport = async (restaurantId, from, to, categoryId) =>', rep: 'const getItemSalesReport = async (restaurantId, from, to, categoryId, db) =>' },
    { sig: 'const getCategorySalesReport = async (restaurantId, from, to) =>', rep: 'const getCategorySalesReport = async (restaurantId, from, to, db) =>' },
    { sig: 'const getPaymentReport = async (restaurantId, from, to) =>', rep: 'const getPaymentReport = async (restaurantId, from, to, db) =>' },
    { sig: 'const getOrderReport = async (restaurantId, from, to, statusFilter, page, pageSize) =>', rep: 'const getOrderReport = async (restaurantId, from, to, statusFilter, page, pageSize, db) =>' },
    { sig: 'const getRevenueTrend = async (restaurantId, from, to, interval = "daily") =>', rep: 'const getRevenueTrend = async (restaurantId, from, to, interval = "daily", db) =>' },
    { sig: 'const getSalesBills = async (restaurantId, from, to) =>', rep: 'const getSalesBills = async (restaurantId, from, to, db) =>' },
    { sig: 'const getDailyReport = async (restaurantId, date) =>', rep: 'const getDailyReport = async (restaurantId, date, db) =>' },
  ],
  'src/services/report-extended.service.js': [
    { sig: 'const getHourlySalesReport = async (restaurantId, from, to) =>', rep: 'const getHourlySalesReport = async (restaurantId, from, to, db) =>' },
    { sig: 'const getSalesComparisonReport = async (restaurantId, from, to, prevFrom, prevTo) =>', rep: 'const getSalesComparisonReport = async (restaurantId, from, to, prevFrom, prevTo, db) =>' },
    { sig: 'const getDiscountReport = async (restaurantId, from, to) =>', rep: 'const getDiscountReport = async (restaurantId, from, to, db) =>' },
    { sig: 'const getCancellationReport = async (restaurantId, from, to) =>', rep: 'const getCancellationReport = async (restaurantId, from, to, db) =>' },
    { sig: 'const getKotRegister = async (restaurantId, from, to) =>', rep: 'const getKotRegister = async (restaurantId, from, to, db) =>' },
    { sig: 'const getKotSummary = async (restaurantId, from, to) =>', rep: 'const getKotSummary = async (restaurantId, from, to, db) =>' },
    { sig: 'const getKitchenPerformance = async (restaurantId, from, to) =>', rep: 'const getKitchenPerformance = async (restaurantId, from, to, db) =>' },
    { sig: 'const getMenuPerformance = async (restaurantId, from, to) =>', rep: 'const getMenuPerformance = async (restaurantId, from, to, db) =>' },
    { sig: 'const getTopSellingItems = async (restaurantId, from, to, sortBy = "quantity") =>', rep: 'const getTopSellingItems = async (restaurantId, from, to, sortBy = "quantity", db) =>' },
    { sig: 'const getLowSellingItems = async (restaurantId, from, to, threshold = 5) =>', rep: 'const getLowSellingItems = async (restaurantId, from, to, threshold = 5, db) =>' },
    { sig: 'const getCategoryPerformance = async (restaurantId, from, to) =>', rep: 'const getCategoryPerformance = async (restaurantId, from, to, db) =>' },
    { sig: 'const getTableSales = async (restaurantId, from, to) =>', rep: 'const getTableSales = async (restaurantId, from, to, db) =>' },
    { sig: 'const getTableOccupancy = async (restaurantId) =>', rep: 'const getTableOccupancy = async (restaurantId, db) =>' },
    { sig: 'const getStaffSales = async (restaurantId, from, to) =>', rep: 'const getStaffSales = async (restaurantId, from, to, db) =>' },
    { sig: 'const getStaffActivity = async (restaurantId, from, to) =>', rep: 'const getStaffActivity = async (restaurantId, from, to, db) =>' },
    { sig: 'const getStaffDiscountCancellation = async (restaurantId, from, to) =>', rep: 'const getStaffDiscountCancellation = async (restaurantId, from, to, db) =>' },
    { sig: 'const getDailyClosing = async (restaurantId, date) =>', rep: 'const getDailyClosing = async (restaurantId, date, db) =>' },
    { sig: 'const getMonthlySummary = async (restaurantId, from, to) =>', rep: 'const getMonthlySummary = async (restaurantId, from, to, db) =>' },
    { sig: 'const getRestaurantPerformance = async (restaurantId, from, to) =>', rep: 'const getRestaurantPerformance = async (restaurantId, from, to, db) =>' },
  ]
};

for (const [file, fixes] of Object.entries(serviceFixes)) {
  let content = fs.readFileSync(file, 'utf8');
  
  for (const { sig, rep } of fixes) {
    content = content.replace(sig, rep);
  }
  
  // Now inject `const prisma = db || platformPrisma;` after each function opening
  // Find all function signatures that now have `db` param and inject after `{`
  for (const { rep } of fixes) {
    // Escape for regex
    const escaped = rep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped.replace(rep.split('=>')[0].trim().slice(0, -2), '.+').replace(/db\) =>/, 'db) =>') + '\\s*\\{', 'g');
    // Simpler: just replace the exact signature + opening brace
    const sigPlusBrace = rep + ' {';
    if (content.includes(sigPlusBrace) && !content.includes(sigPlusBrace + '\n    const prisma = db || platformPrisma;')) {
      content = content.replace(sigPlusBrace, sigPlusBrace + '\n    const prisma = db || platformPrisma;');
    }
  }
  
  fs.writeFileSync(file, content);
  console.log(`Updated ${file}`);
}

// Also fix the getPaidSalesItems function which uses 'function' syntax
let reportCode = fs.readFileSync('src/services/report.service.js', 'utf8');
const paidItemsSig = 'async function getPaidSalesItems(restaurantId, from, to, db) {';
if (reportCode.includes(paidItemsSig) && !reportCode.includes(paidItemsSig + '\n    const prisma = db || platformPrisma;')) {
  reportCode = reportCode.replace(paidItemsSig, paidItemsSig + '\n    const prisma = db || platformPrisma;');
  fs.writeFileSync('src/services/report.service.js', reportCode);
  console.log('Fixed getPaidSalesItems');
}
