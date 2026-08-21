const prisma = require("../config/prisma");
const { successResponse, errorResponse } = require("../utils/response");

const createCategory = async (req, res) => {
  try {
    const { name, image, color, icon, sortOrder, isActive } = req.body;

    const existingCategory =
      await prisma.category.findFirst({
        where: {
          restaurantId: req.user.restaurantId,
          name
        }
      });

    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: "Category already exists"
      });
    }

    const category =
      await prisma.category.create({
        data: {
          restaurantId: req.user.restaurantId,
          name,
          image,
          color: color || '#16A34A',
          icon: icon || 'utensils',
          sortOrder: sortOrder || 0,
          isActive: isActive !== false
        }
      });

    res.status(201).json({
      success: true,
      category
    });

  } catch (error) {

    console.error(error);return errorResponse(res, error.message);}
};

const getCategories = async (req, res) => {
  try {

    if (!req.user.restaurantId) {
      return res.status(200).json({
        success: true,
        categories: []
      });
    }

    const categories =
      await prisma.category.findMany({

        where: {
          restaurantId: req.user.restaurantId
        },

        orderBy: {
          name: "asc"
        }

      });

    res.status(200).json({
      success: true,
      categories
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const updateCategory = async (req, res) => {

  try {

    const { id } = req.params;

    const { name, image, color, icon, sortOrder, isActive } = req.body;

    // Check category belongs to logged-in restaurant
    const existingCategory = await prisma.category.findFirst({

      where: {

        id: Number(id),

        restaurantId: req.user.restaurantId

      }

    });

    if (!existingCategory) {

      return res.status(404).json({

        success: false,

        message: "Category not found"

      });

    }

    // Check duplicate category name within same restaurant
    const duplicateCategory = await prisma.category.findFirst({

      where: {

        restaurantId: req.user.restaurantId,

        name,

        NOT: {

          id: Number(id)

        }

      }

    });

    if (duplicateCategory) {

      return res.status(400).json({

        success: false,

        message: "Category name already exists"

      });

    }

    const category = await prisma.category.update({

      where: {

        id: Number(id)

      },

      data: {

        name,

        image,

        color,

        icon,

        sortOrder,

        isActive

      }

    });

    return res.status(200).json({

      success: true,

      message: "Category updated successfully",

      category

    });

  } catch (error) {

    console.error(error);return errorResponse(res, error.message);}

};

const deleteCategory = async (req, res) => {
  try {

    const { id } = req.params;

    const category =
      await prisma.category.findFirst({

        where: {
          id: Number(id),
          restaurantId: req.user.restaurantId
        }

      });

    if (!category) {

      return res.status(404).json({

        success: false,

        message: "Category not found"

      });

    }

    await prisma.category.delete({

      where: {
        id: category.id
      }

    });

    res.status(200).json({
      success: true,
      message: "Category deleted"
    });

  } catch (error) {return errorResponse(res, error.message);}
};

module.exports = {
  createCategory,
  getCategories,
  updateCategory,
  deleteCategory
};