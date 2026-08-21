const prisma = require("../config/prisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const asyncHandler = require("../utils/asyncHandler");
const { getRestaurantSubscription } = require("../utils/subscription");

// const register = async (req, res) => {
//   try {
//     const { name, email, password, role } = req.body;

//     const existingUser = await prisma.user.findUnique({
//       where: { email }
//     });

//     if (existingUser) {
//       return res.status(400).json({
//         success: false,
//         message: "Email already exists"
//       });
//     }

//     const hashedPassword = await bcrypt.hash(password, 10);

//     const user = await prisma.user.create({
//       data: {
//         name,
//         email,
//         password: hashedPassword,
//         role
//       }
//     });

//     res.status(201).json({
//       success: true,
//       message: "User registered successfully",
//       user
//     });

//   } catch (error) {
//     console.log(error);

//     res.status(500).json({
//       success: false,
//       message: "Server Error"
//     });
//   }
// };
const register = async (req, res) => {

  try {

    const {

      restaurantId,
      name,
      email,
      password,
      role

    } = req.body;

    console.log("Restaurant ID from request:", restaurantId);

    const restaurant = await prisma.restaurant.findUnique({

      where: {

        id: Number(restaurantId)

      }

    });

    console.log("Restaurant:", restaurant);

    if (!restaurant) {

      return res.status(404).json({

        success: false,

        message: "Restaurant not found"

      });

    }

    const existingUser = await prisma.user.findUnique({

      where: {

        email

      }

    });

    if (existingUser) {

      return res.status(400).json({

        success: false,

        message: "Email already exists"

      });

    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({

      data: {

        restaurantId: Number(restaurantId),

        name,

        email,

        password: hashedPassword,

        role

      }

    });

    res.status(201).json({

      success: true,

      message: "User registered successfully",

      user

    });

  }

  catch (error) {

    console.log(error);

    res.status(500).json({

      success: false,

      message: "Server Error"

    });

  }

};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid Credentials"
      });
    }

    if (user.deletedAt) {
      return res.status(401).json({
        success: false,
        message: "Invalid Credentials"
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been disabled."
      });
    }

    if (!user.password) {
      console.error(`Login failed: User ${user.id} (${email}) has no password set`);
      return res.status(401).json({
        success: false,
        message: "Invalid Credentials"
      });
    }

    const isMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid Credentials"
      });
    }

    // ── Multi-tenant subscription gate (restaurant staff only) ──
    let subscription = null;
    if (user.restaurantId && user.role !== "SUPER_ADMIN") {
      const restaurant = await prisma.restaurant.findUnique({ where: { id: user.restaurantId } });
      if (!restaurant || restaurant.deletedAt) {
        return res.status(403).json({ success: false, message: "Your restaurant account is no longer available." });
      }
      if (restaurant.status !== "ACTIVE") {
        return res.status(403).json({ success: false, message: "Your restaurant account is " + restaurant.status.toLowerCase() + ". Contact your Super Admin." });
      }
      subscription = await getRestaurantSubscription(user.restaurantId);
      // An EXPIRED subscription still allows login (the ADMIN must be able to
      // reach Subscription & Billing and renew). POS/API access stays blocked
      // server-side by the protect/feature middleware for every other route.
      if (!subscription) {
        return res.status(403).json({ success: false, message: "No subscription found for your restaurant. Contact your Super Admin." });
      }
      if (subscription.status === "CANCELLED" || subscription.status === "SUSPENDED") {
        const reason = subscription.status === "CANCELLED"
          ? "Your subscription has been cancelled. Contact support to renew."
          : "Your subscription is suspended. Contact support to reactivate.";
        return res.status(403).json({ success: false, message: reason });
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    });

    const tokenPayload = {
      id: user.id,
      role: user.role
    };

    // SUPER_ADMIN has no restaurantId — omit from JWT to keep payload clean
    if (user.role !== "SUPER_ADMIN") {
      tokenPayload.restaurantId = user.restaurantId;
    }

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    let settings = null;

    if (user.restaurantId && user.role !== "SUPER_ADMIN") {
      settings = await prisma.restaurantSetting.findUnique({
        where: { restaurantId: user.restaurantId },
        select: {
          restaurantName: true,
          currency: true,
          timezone: true,
          taxPercentage: true,
          serviceCharge: true,
          roundOffEnabled: true,
          billPrefix: true,
          invoicePrefix: true,
          kotPrefix: true,
          enableKitchenDisplay: true,
          enableKotStatusTracking: true,
          logo: true
        }
      });
    }

    // Strip password from user object before sending response
    const { password: _, ...safeUser } = user;

    res.status(200).json({
      success: true,
      token,
      user: safeUser,
      settings,
      subscription // live subscription snapshot (plan, limits, features, status)
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};
const verifyPassword = async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.user.id;

    if (!password || password.length < 1) {
      return res.status(400).json({
        success: false,
        message: "Password is required"
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "User not found"
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Invalid password"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Password verified successfully"
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};

/**
 * Self-service password change for the authenticated user (e.g. Restaurant Admin).
 * Verifies the current password, validates the new one, hashes it before saving,
 * and records passwordChangedAt so all existing sessions can be invalidated.
 */
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required."
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters long."
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password cannot be the same as the current password."
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "User not found"
      });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect."
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        passwordChangedAt: new Date()
      }
    });

    return res.status(200).json({
      success: true,
      message: "Password changed successfully. Please sign in again."
    });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};

const profile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: {
        id: req.user.id
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        restaurantId: true
      }
    });

    let subscription = null;
    if (user && user.restaurantId && user.role !== "SUPER_ADMIN") {
      subscription = await getRestaurantSubscription(user.restaurantId);
    }

    res.status(200).json({
      success: true,
      user,
      subscription
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      message: "Server Error"
    });

  }
};

module.exports = {
  register,
  login,
  changePassword,
  profile,
  verifyPassword
};