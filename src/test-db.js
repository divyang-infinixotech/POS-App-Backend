const prisma = require("./config/prisma");

async function testConnection() {
  try {
    await prisma.$connect();

    console.log(
      "Database connected successfully"
    );

    await prisma.$disconnect();
  } catch (error) {
    console.error(
      "Database connection failed"
    );

    console.error(error);
  }
}

testConnection();