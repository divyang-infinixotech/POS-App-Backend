/**
 * Showcase tenant catalog population — uses ONLY the real tenant HTTP APIs
 * (category → subcategory → menu item → floor → table → settings), so every
 * validation, permission and default behaves exactly as in production.
 *
 * Existing data is never touched; only the four new showcase tenants are
 * populated. Run: node scripts/populate-showcase.js
 */
const http = require("http");

const BASE = { host: "localhost", port: 5001 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { ...BASE, path, method, headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(out); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(email, password) {
  const r = await call("POST", "/api/auth/login", null, { email, password });
  if (!r.json || !r.json.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r).slice(0, 200)}`);
  return r.json.token;
}

async function main() {
  // ── tenants to populate ──
  const tenants = [
    {
      name: "The Oven Story Bakery", email: "aarav.mehta+ovenstory@gmail.com", password: "OvenStory#2026",
      settings: { taxPercentage: 5, enableCounterSale: true, receiptFooter: "Thank you for visiting The Oven Story Bakery!" },
      categories: [
        { name: "Cakes", color: "#8B4513", icon: "🍰", items: [
          ["Chocolate Truffle Cake", 650, "Rich three-layer chocolate cake with smooth truffle ganache.", true, "VEG"],
          ["Black Forest Cake", 600, "Classic black forest with whipped cream, cherries and chocolate shavings.", true, "VEG"],
          ["Red Velvet Cake", 750, "Velvety red sponge with cream cheese frosting.", true, "VEG"],
          ["Pineapple Cake", 550, "Light sponge layered with pineapple and fresh cream.", true, "VEG"],
        ]},
        { name: "Pastries", color: "#D2691E", icon: "🧁", items: [
          ["Chocolate Truffle Pastry", 120, "Decadent truffle pastry with dark chocolate curls.", true, "VEG"],
          ["Red Velvet Pastry", 140, "Red velvet pastry with a cream cheese swirl.", true, "VEG"],
          ["Black Forest Pastry", 110, "Cherry-filled pastry topped with chocolate.", true, "VEG"],
        ]},
        { name: "Breads", color: "#C8A165", icon: "🥖", items: [
          ["White Bread", 55, "Soft everyday white loaf, baked fresh every morning.", true, "VEG"],
          ["Multigrain Bread", 75, "Hearty loaf with oats, flax and sunflower seeds.", true, "VEG"],
          ["Garlic Bread", 110, "Toasted baguette with garlic herb butter.", true, "VEG"],
        ]},
        { name: "Cookies", color: "#B8860B", icon: "🍪", items: [
          ["Butter Cookies", 90, "Melt-in-the-mouth butter cookies, 250g box.", true, "VEG"],
          ["Chocolate Chip Cookies", 120, "Crisp cookies loaded with Belgian chocolate chips, 250g.", true, "VEG"],
          ["Oatmeal Cookies", 100, "Chewy oatmeal cookies with a hint of cinnamon, 250g.", true, "VEG"],
        ]},
        { name: "Beverages", color: "#6B4226", icon: "☕", items: [
          ["Cold Coffee", 140, "Creamy blended cold coffee topped with whipped cream.", true, "VEG"],
          ["Masala Chai", 60, "Traditional spiced Indian tea, brewed fresh.", true, "VEG"],
          ["Fresh Lime Soda", 80, "Refreshing lime soda — sweet, salted or mixed.", true, "VEG"],
        ]},
      ],
    },
    {
      name: "GreenBasket Supermarket", email: "rohan.shah+greenbasket@gmail.com", password: "GreenBasket#2026",
      settings: { taxPercentage: 5, enableCounterSale: true, receiptFooter: "Thank you for shopping at GreenBasket!" },
      categories: [
        { name: "Groceries", color: "#E8A33D", icon: "🛒", items: [
          ["Tata Salt 1kg", 28, "Iodised free-flowing salt, 1kg pack.", true, "VEG", { sku: "GB-GRO-001", barcode: "8901011000011", stock: 120 }],
          ["Aashirvaad Atta 5kg", 295, "Whole wheat atta, 5kg pack.", true, "VEG", { sku: "GB-GRO-002", barcode: "8901011000028", stock: 60 }],
          ["India Gate Basmati Rice 5kg", 625, "Aged long-grain basmati rice, 5kg.", true, "VEG", { sku: "GB-GRO-003", barcode: "8901011000035", stock: 40 }],
          ["Fortune Sunflower Oil 1L", 145, "Refined sunflower oil, 1L pouch.", true, "VEG", { sku: "GB-GRO-004", barcode: "8901011000042", stock: 80 }],
        ]},
        { name: "Dairy & Bakery", color: "#5B8DEF", icon: "🥛", items: [
          ["Amul Taaza Milk 1L", 68, "Toned milk pouch, 1 litre.", true, "VEG", { sku: "GB-DRY-001", barcode: "8901011000059", stock: 90 }],
          ["Amul Butter 500g", 285, "Salted table butter, 500g.", true, "VEG", { sku: "GB-DRY-002", barcode: "8901011000066", stock: 45 }],
          ["Britannia Bread 400g", 45, "Soft white sandwich bread, 400g.", true, "VEG", { sku: "GB-DRY-003", barcode: "8901011000073", stock: 55 }],
          ["Amul Cheese Slices 200g", 145, "Processed cheese slices, 200g (10 slices).", true, "VEG", { sku: "GB-DRY-004", barcode: "8901011000080", stock: 50 }],
        ]},
        { name: "Beverages", color: "#C0392B", icon: "🥤", items: [
          ["Coca-Cola 750ml", 45, "Chilled carbonated soft drink, 750ml PET.", true, "VEG", { sku: "GB-BEV-001", barcode: "8901011000097", stock: 100 }],
          ["Sprite 750ml", 45, "Lime-flavoured carbonated drink, 750ml PET.", true, "VEG", { sku: "GB-BEV-002", barcode: "8901011000103", stock: 100 }],
          ["Tata Tea 250g", 145, "Premium blended leaf tea, 250g.", true, "VEG", { sku: "GB-BEV-003", barcode: "8901011000110", stock: 65 }],
          ["Nescafé Classic 100g", 285, "Instant coffee granules, 100g jar.", true, "VEG", { sku: "GB-BEV-004", barcode: "8901011000127", stock: 40 }],
        ]},
        { name: "Snacks", color: "#F1C40F", icon: "🍿", items: [
          ["Lay's Classic Salted 52g", 20, "Crispy potato chips, classic salted.", true, "VEG", { sku: "GB-SNK-001", barcode: "8901011000134", stock: 150 }],
          ["Kurkure Masala Munch 90g", 30, "Crunchy corn puffs with masala flavour.", true, "VEG", { sku: "GB-SNK-002", barcode: "8901011000141", stock: 140 }],
          ["Parle-G Biscuits 800g", 85, "India's favourite glucose biscuits, 800g pack.", true, "VEG", { sku: "GB-SNK-003", barcode: "8901011000158", stock: 90 }],
          ["Haldiram's Aloo Bhujia 200g", 75, "Crunchy potato bhujia namkeen, 200g.", true, "VEG", { sku: "GB-SNK-004", barcode: "8901011000165", stock: 70 }],
        ]},
        { name: "Personal Care", color: "#16A085", icon: "🧴", items: [
          ["Dove Beauty Bar 100g", 65, "Moisturising beauty bar, 100g.", true, "VEG", { sku: "GB-PC-001", barcode: "8901011000172", stock: 85 }],
          ["Colgate Strong Teeth 200g", 125, "Anti-cavity toothpaste, 200g.", true, "VEG", { sku: "GB-PC-002", barcode: "8901011000189", stock: 95 }],
          ["Head & Shoulders Shampoo 180ml", 185, "Anti-dandruff shampoo, 180ml.", true, "VEG", { sku: "GB-PC-003", barcode: "8901011000196", stock: 60 }],
          ["Dettol Handwash 250ml", 110, "Germ-protection liquid handwash, 250ml.", true, "VEG", { sku: "GB-PC-004", barcode: "8901011000202", stock: 75 }],
        ]},
      ],
    },
    {
      name: "UrbanStyle Fashion", email: "neha.patel+urbanstyle@gmail.com", password: "UrbanStyle#2026",
      settings: { taxPercentage: 12, enableCounterSale: true, receiptFooter: "Thank you for shopping at UrbanStyle Fashion!" },
      categories: [
        { name: "T-Shirts", color: "#3B82F6", icon: "👕", items: [
          ["Classic Crew Neck T-Shirt", 499, "100% combed cotton crew neck, regular fit.", true, "VEG", { sku: "US-TSH-001", barcode: "8902022000019", stock: 60 }],
          ["Oversized Cotton T-Shirt", 699, "Relaxed oversized fit in heavyweight cotton.", true, "VEG", { sku: "US-TSH-002", barcode: "8902022000026", stock: 45 }],
          ["Printed Graphic T-Shirt", 599, "Statement graphic print on soft cotton.", true, "VEG", { sku: "US-TSH-003", barcode: "8902022000033", stock: 50 }],
          ["Polo T-Shirt", 799, "Classic polo with ribbed collar, pique knit.", true, "VEG", { sku: "US-TSH-004", barcode: "8902022000040", stock: 40 }],
        ]},
        { name: "Shirts", color: "#8B5CF6", icon: "👔", items: [
          ["Regular Fit Casual Shirt", 999, "Everyday casual shirt in breathable cotton.", true, "VEG", { sku: "US-SHT-001", barcode: "8902022000057", stock: 35 }],
          ["Slim Fit Oxford Shirt", 1199, "Slim-fit oxford weave, wardrobe essential.", true, "VEG", { sku: "US-SHT-002", barcode: "8902022000064", stock: 30 }],
          ["Checked Casual Shirt", 1099, "All-season checked shirt with soft finish.", true, "VEG", { sku: "US-SHT-003", barcode: "8902022000071", stock: 32 }],
        ]},
        { name: "Jeans", color: "#1E3A8A", icon: "👖", items: [
          ["Slim Fit Blue Jeans", 1499, "Stretchable slim-fit denim in mid blue.", true, "VEG", { sku: "US-JNS-001", barcode: "8902022000088", stock: 28 }],
          ["Straight Fit Jeans", 1399, "Timeless straight fit with clean finish.", true, "VEG", { sku: "US-JNS-002", barcode: "8902022000095", stock: 26 }],
          ["Relaxed Fit Black Jeans", 1599, "Comfort-stretch relaxed denim in jet black.", true, "VEG", { sku: "US-JNS-003", barcode: "8902022000101", stock: 22 }],
        ]},
        { name: "Dresses", color: "#DB2777", icon: "👗", items: [
          ["Floral Midi Dress", 1299, "Breezy floral print midi with tie waist.", true, "VEG", { sku: "US-DRS-001", barcode: "8902022000118", stock: 20 }],
          ["Solid Casual Dress", 999, "Everyday solid dress with side pockets.", true, "VEG", { sku: "US-DRS-002", barcode: "8902022000125", stock: 24 }],
          ["Printed Summer Dress", 1199, "Light georgette summer dress, lined.", true, "VEG", { sku: "US-DRS-003", barcode: "8902022000132", stock: 18 }],
        ]},
        { name: "Accessories", color: "#0D9488", icon: "🧢", items: [
          ["Canvas Belt", 399, "Durable woven canvas belt with metal buckle.", true, "VEG", { sku: "US-ACC-001", barcode: "8902022000149", stock: 55 }],
          ["Everyday Cap", 299, "Adjustable cotton twill cap.", true, "VEG", { sku: "US-ACC-002", barcode: "8902022000156", stock: 65 }],
          ["Casual Sling Bag", 799, "Compact water-resistant sling bag.", true, "VEG", { sku: "US-ACC-003", barcode: "8902022000163", stock: 30 }],
          ["Cotton Socks (3 Pairs)", 199, "Soft breathable ankle socks, pack of 3.", true, "VEG", { sku: "US-ACC-004", barcode: "8902022000170", stock: 80 }],
        ]},
      ],
    },
    {
      name: "Spice Garden Restaurant", email: "vikram.joshi+spicegarden@gmail.com", password: "SpiceGarden#2026",
      settings: { taxPercentage: 5, enableCounterSale: true, receiptFooter: "Thank you for dining at Spice Garden!", dietaryMode: "BOTH" },
      floors: [
        { name: "Ground Floor", floorCode: "GF", tables: [
          ["1", 2], ["2", 2], ["3", 4], ["4", 4], ["5", 6],
        ]},
        { name: "First Floor", floorCode: "FF", tables: [
          ["11", 2], ["12", 4], ["13", 4], ["14", 6],
        ]},
      ],
      categories: [
        { name: "Starters", color: "#E67E22", icon: "🍤", subs: [
          { name: "Veg Starters", items: [
            ["Paneer Tikka", 280, "Char-grilled cottage cheese with mint chutney.", true, "VEG"],
            ["Hara Bhara Kebab", 220, "Spinach and green pea patties, crisp fried.", true, "VEG"],
          ]},
          { name: "Non-Veg Starters", items: [
            ["Chicken Tikka", 340, "Tandoor-grilled chicken marinated in yogurt and spices.", false, "NON_VEG"],
            ["Chicken Seekh Kebab", 320, "Minced chicken skewers with aromatic spices.", false, "NON_VEG"],
          ]},
        ]},
        { name: "Main Course", color: "#C0392B", icon: "🍛", subs: [
          { name: "North Indian", items: [
            ["Paneer Butter Masala", 290, "Cottage cheese in silky tomato-butter gravy.", true, "VEG"],
            ["Dal Makhani", 240, "Slow-cooked black lentils with cream.", true, "VEG"],
            ["Kadai Paneer", 280, "Wok-tossed paneer with bell peppers and kadai masala.", true, "VEG"],
          ]},
          { name: "Non-Veg", items: [
            ["Butter Chicken", 360, "Tandoori chicken in rich tomato-butter gravy.", false, "NON_VEG"],
            ["Chicken Kadai", 340, "Chicken tossed with crushed coriander and spices.", false, "NON_VEG"],
          ]},
        ]},
        { name: "Breads", color: "#D4A76A", icon: "🫓", subs: [
          { name: "Tandoori Breads", items: [
            ["Tandoori Roti", 25, "Whole wheat roti from the tandoor.", true, "VEG"],
            ["Butter Naan", 55, "Soft leavened naan brushed with butter.", true, "VEG"],
            ["Garlic Naan", 75, "Naan topped with garlic butter and coriander.", true, "VEG"],
            ["Laccha Paratha", 65, "Layered whole wheat paratha.", true, "VEG"],
          ]},
        ]},
        { name: "Rice & Biryani", color: "#27AE60", icon: "🍚", subs: [
          { name: "Biryani & Rice", items: [
            ["Veg Biryani", 260, "Fragrant basmati layered with vegetables and spices.", true, "VEG"],
            ["Chicken Biryani", 340, "Dum-cooked chicken biryani with raita.", false, "NON_VEG"],
            ["Steamed Rice", 160, "Plain steamed basmati rice.", true, "VEG"],
          ]},
        ]},
        { name: "Beverages", color: "#3498DB", icon: "🥤", subs: [
          { name: "Coolers & Drinks", items: [
            ["Masala Chaas", 70, "Spiced buttermilk with roasted cumin.", true, "VEG"],
            ["Fresh Lime Soda", 90, "Sweet-salted lime soda, made to order.", true, "VEG"],
            ["Cold Coffee", 140, "Chilled blended coffee with ice cream.", true, "VEG"],
            ["Mineral Water", 30, "Packaged drinking water, 1L.", true, "VEG"],
          ]},
        ]},
        { name: "Desserts", color: "#9B59B6", icon: "🍮", subs: [
          { name: "Sweet Endings", items: [
            ["Gulab Jamun", 100, "Warm milk dumplings in cardamom syrup (2 pcs).", true, "VEG"],
            ["Brownie with Ice Cream", 180, "Fudgy brownie with vanilla ice cream.", true, "VEG"],
            ["Kulfi", 120, "Traditional slow-churned malai kulfi.", true, "VEG"],
          ]},
        ]},
      ],
    },
  ];

  const summary = [];
  for (const t of tenants) {
    console.log(`\n══ ${t.name} ══`);
    const token = await login(t.email, t.password);
    const counts = { cats: 0, subs: 0, items: 0, floors: 0, tables: 0, errors: 0 };

    // Settings
    const st = await call("POST", "/api/settings", token, { restaurantName: t.name, currency: "INR", timezone: "Asia/Kolkata", language: "en", ...t.settings });
    console.log(`settings: ${st.status}`);
    if (st.status >= 300) counts.errors++;

    // Floors + tables (restaurant only)
    if (t.floors) {
      for (const f of t.floors) {
        const fr = await call("POST", "/api/floors", token, { name: f.name, floorCode: f.floorCode, isActive: true });
        const floorId = fr.json?.floor?.id ?? fr.json?.data?.floor?.id ?? fr.json?.data?.id;
        console.log(`floor "${f.name}": ${fr.status} id=${floorId}`);
        if (fr.status < 300 && floorId) {
          counts.floors++;
          for (const [tableNo, capacity] of f.tables) {
            const tr = await call("POST", "/api/tables", token, { tableNo, capacity, floorId });
            if (tr.status < 300) counts.tables++; else { console.log(`  table ${tableNo} FAIL ${tr.status}: ${JSON.stringify(tr.json).slice(0, 120)}`); counts.errors++; }
          }
        } else { counts.errors++; }
      }
    }

    // Categories → (subcategories) → items
    for (const c of t.categories) {
      const cr = await call("POST", "/api/categories", token, { name: c.name, color: c.color || null, icon: c.icon || null });
      const catId = cr.json?.category?.id ?? cr.json?.data?.category?.id ?? cr.json?.data?.id;
      if (!(cr.status < 300 && catId)) { console.log(`category "${c.name}" FAIL ${cr.status}: ${JSON.stringify(cr.json).slice(0, 150)}`); counts.errors++; continue; }
      counts.cats++;

      if (c.subs) {
        for (const s of c.subs) {
          const sr = await call("POST", "/api/menu/subcategories", token, { categoryId: catId, name: s.name });
          const subId = sr.json?.subcategory?.id ?? sr.json?.data?.subcategory?.id ?? sr.json?.data?.id;
          if (!(sr.status < 300 && subId)) { console.log(`sub "${s.name}" FAIL ${sr.status}: ${JSON.stringify(sr.json).slice(0, 150)}`); counts.errors++; continue; }
          counts.subs++;
          for (const it of s.items) {
            const body = { name: it[0], price: it[1], description: it[2], isVeg: it[3], dietaryType: it[4], categoryId: catId, subcategoryId: subId, tax: t.settings.taxPercentage ?? 5, isAvailable: true };
            const ir = await call("POST", "/api/menu", token, body);
            if (ir.status < 300) counts.items++; else { console.log(`item "${it[0]}" FAIL ${ir.status}: ${JSON.stringify(ir.json).slice(0, 150)}`); counts.errors++; }
          }
        }
      }
      for (const it of (c.items || [])) {
        const body = { name: it[0], price: it[1], description: it[2], isVeg: it[3], dietaryType: it[4], categoryId: catId, tax: t.settings.taxPercentage ?? 5, isAvailable: true };
        if (it[5]) { body.sku = it[5].sku; body.barcode = it[5].barcode; body.currentStock = it[5].stock; }
        const ir = await call("POST", "/api/menu", token, body);
        if (ir.status < 300) counts.items++; else { console.log(`item "${it[0]}" FAIL ${ir.status}: ${JSON.stringify(ir.json).slice(0, 150)}`); counts.errors++; }
      }
    }
    console.log(`→ ${counts.cats} categories, ${counts.subs} subcategories, ${counts.items} items, ${counts.floors} floors, ${counts.tables} tables, ${counts.errors} errors`);
    summary.push({ name: t.name, ...counts });
  }

  console.log("\n════ POPULATION SUMMARY ════");
  for (const s of summary) console.log(`${s.name}: ${s.cats} cats / ${s.subs} subs / ${s.items} items / ${s.floors} floors / ${s.tables} tables / ${s.errors} errors`);
  process.exit(summary.some((s) => s.errors) ? 1 : 0);
}

main().catch((e) => { console.error("population crashed:", e.message, "\n", e.stack); process.exit(1); });
