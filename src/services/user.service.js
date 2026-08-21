const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");

const changePassword = async (

    userId,

    currentPassword,

    newPassword

) => {

    const user = await prisma.user.findUnique({

        where: {

            id: userId

        }

    });

    if (!user) {

        throw new Error("User not found.");

    }

    const isMatch = await bcrypt.compare(

        currentPassword,

        user.password

    );

    if (!isMatch) {

        throw new Error("Current password is incorrect.");

    }

    if (currentPassword === newPassword) {

        throw new Error(

            "New password cannot be the same as the current password."

        );

    }

    const hashedPassword = await bcrypt.hash(

        newPassword,

        10

    );

    await prisma.user.update({

        where: {

            id: userId

        },

        data: {

            password: hashedPassword,

            passwordChangedAt: new Date()

        }

    });

    return true;

};

module.exports = {

    changePassword

};