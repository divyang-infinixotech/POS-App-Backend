const bcrypt = require("bcryptjs");

(async () => {
  const hash =
    "$2b$10$tl.E8a/lgzdzX86xExRzIez5aNxHsHRYjhW4fbliB1jXzfRV4HIRO";

  const result = await bcrypt.compare("Admin@123", hash);

  console.log(result);
})();