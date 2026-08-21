const prisma = require("../config/prisma");
const {
  storage,
  buildPublicId,
  parseRestaurantId,
  isOwnStorageUrl,
  isExternalUrl
} = require("../services/storage.service");
const { validateImageBuffer, processImage } = require("../services/image.service");

const { successResponse, errorResponse } = require("../utils/response");

// ─── Image input helpers ───────────────────────────────────────────────────────

/**
 * Normalize + validate the image fields coming from a create/update request.
 * Only application-storage references are accepted; arbitrary external URLs are rejected.
 */
const sanitizeImageInput = ({ image, imagePublicId, existingItem, restaurantId }) => {
  // Explicitly cleared → remove the image
  if (image == null || image === "" || image === "null") {
    return { image: null, imagePublicId: null, imageIsExternal: false };
  }
  // Unchanged value (existing stored image or legacy external URL kept as-is)
  if (existingItem && image === existingItem.image) {
    return {
      image: existingItem.image,
      imagePublicId: existingItem.imagePublicId || null,
      imageIsExternal: existingItem.imageIsExternal || isExternalUrl(existingItem.image)
    };
  }
  // Our own storage URL → must carry a valid, restaurant-owned publicId
  if (isOwnStorageUrl(image)) {
    const ownerId = parseRestaurantId(imagePublicId);
    if (!ownerId) {
      throw Object.assign(new Error("Invalid image reference. Please re-upload the image."), { statusCode: 400 });
    }
    if (ownerId !== Number(restaurantId)) {
      throw Object.assign(
        new Error("You do not have permission to use this image."),
        { statusCode: 403 }
      );
    }
    return { image, imagePublicId: String(imagePublicId), imageIsExternal: false };
  }
  if (isExternalUrl(image)) {
    throw Object.assign(
      new Error("External image URLs are not allowed. Upload an image file instead."),
      { statusCode: 400 }
    );
  }
  throw Object.assign(
    new Error("Invalid image value. Please upload an image file (JPG, PNG or WebP)."),
    { statusCode: 400 }
  );
};

/** True when another menu item still references the given image. */
const isImageReferencedElsewhere = async (publicId, excludeItemId) => {
  const count = await prisma.menuItem.count({
    where: { imagePublicId: publicId, id: { not: Number(excludeItemId) } }
  });
  return count > 0;
};

const createMenuItem = async (req, res) => {

  try {

    const {
      name,
      shortName,
      sku,
      barcode,
      description,
      shortDescription,
      image,
      imagePublicId,
      images,
      price,
      costPrice,
      gstPercentage,
      taxInclusive,
      tax,
      preparationTime,
      kitchenCategory,
      displayOrder,
      spicyLevel,
      isVeg,
      isAvailable,
      isFeatured,
      isRecommended,
      categoryId,
      currentStock,
      minStock,
      maxStock,
      unit,
      modifierOptions
    } = req.body;

    const category = await prisma.category.findFirst({

      where: {

        id: Number(categoryId),

        restaurantId: req.user.restaurantId

      }

    });

    if (!category) {

      return errorResponse(

        res,

        "Category not found",

        404

      );

    }

    const imageData = sanitizeImageInput({
      image,
      imagePublicId,
      existingItem: null,
      restaurantId: req.user.restaurantId
    });

    const menuItem = await prisma.menuItem.create({
      data: {

        restaurantId: req.user.restaurantId,

        name,

        shortName,

        sku,

        barcode,

        description,

        shortDescription: shortDescription || description,

        image: imageData.image,

        imagePublicId: imageData.imagePublicId,

        imageIsExternal: imageData.imageIsExternal,

        images: images || [],

        price: Number(price),

        costPrice: costPrice != null ? Number(costPrice) : null,

        gstPercentage: gstPercentage != null ? Number(gstPercentage) : (tax != null ? Number(tax) : 0),

        taxInclusive: taxInclusive !== false,

        tax: tax != null ? Number(tax) : 0,

        preparationTime: preparationTime || 15,

        kitchenCategory: kitchenCategory || '',

        displayOrder: displayOrder || 0,

        spicyLevel: spicyLevel || 0,

        isVeg: isVeg != null ? isVeg : true,

        isAvailable: isAvailable !== false,

        isFeatured: isFeatured || false,

        isRecommended: isRecommended || false,

        categoryId: Number(categoryId),

        currentStock: currentStock != null ? Number(currentStock) : null,        minStock: minStock != null ? Number(minStock) : 10,
        maxStock: maxStock != null ? Number(maxStock) : null,
        unit: unit || 'piece',
        modifierOptions: modifierOptions || ''
      }
    });

    return successResponse(
      res,
      menuItem,
      "Menu item created successfully",
      201
    );

  } catch (error) {

    console.error(error);

    return errorResponse(
      res,
      error.message,
      error.statusCode || 500
    );

  }

};

const getMenuItems = async (req, res) => {
  try {

    if (!req.user.restaurantId) {
      return res.json({
        success: true,
        items: []
      });
    }

    const items = await prisma.menuItem.findMany({

      where: {

        restaurantId: req.user.restaurantId

      },

      include: {

        category: true

      },

      orderBy: {

        name: "asc"

      }

    });

    res.json({
      success: true,
      items
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const getMenuItemById = async (req, res) => {
  try {

    const item = await prisma.menuItem.findFirst({

      where: {

        id: Number(req.params.id),

        restaurantId: req.user.restaurantId

      },

      include: {

        category: true

      }

    }); if (!item) {

      return errorResponse(

        res,

        "Menu item not found",

        404

      );

    }

    res.json({
      success: true,
      item
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const updateMenuItem = async (req, res) => {
    try {

        const { id } = req.params;

        const {
            name,
            shortName,
            sku,
            barcode,
            description,
            shortDescription,
            image,
            imagePublicId,
            images,
            price,
            costPrice,
            gstPercentage,
            taxInclusive,
            tax,
            preparationTime,
            kitchenCategory,
            displayOrder,
            spicyLevel,
            isVeg,
            isAvailable,
            isFeatured,
            isRecommended,
            categoryId,
            currentStock,
            minStock,
            maxStock,
            unit,
            modifierOptions
        } = req.body;

        const existingItem = await prisma.menuItem.findFirst({
            where: {
                id: Number(id),
                restaurantId: req.user.restaurantId
            }
        });

        if (!existingItem) {
            return errorResponse(
                res,
                "Menu item not found",
                404
            );
        }

        if (categoryId) {

            const category = await prisma.category.findFirst({
                where: {
                    id: Number(categoryId),
                    restaurantId: req.user.restaurantId
                }
            });

            if (!category) {
                return errorResponse(
                    res,
                    "Category not found",
                    404
                );
            }
        }

        // Image fields must be sent together. A lone imagePublicId (or a missing
        // image field) is a malformed request — never wipe a stored image silently.
        const imageChanged = image !== undefined || imagePublicId !== undefined;
        if (imageChanged && image === undefined) {
            return errorResponse(res, "image and imagePublicId must be provided together", 400);
        }

        const imageData = sanitizeImageInput({
            image,
            imagePublicId,
            existingItem,
            restaurantId: req.user.restaurantId
        });

        const updateData = {};
        if (name !== undefined) updateData.name = name;
        if (shortName !== undefined) updateData.shortName = shortName;
        if (sku !== undefined) updateData.sku = sku;
        if (barcode !== undefined) updateData.barcode = barcode;
        if (description !== undefined) updateData.description = description;
        if (shortDescription !== undefined) updateData.shortDescription = shortDescription;
        if (imageChanged) {
            updateData.image = imageData.image;
            updateData.imagePublicId = imageData.imagePublicId;
            updateData.imageIsExternal = imageData.imageIsExternal;
        }
        if (images !== undefined) updateData.images = images;
        if (price !== undefined) updateData.price = Number(price);
        if (costPrice !== undefined) updateData.costPrice = Number(costPrice);
        if (gstPercentage !== undefined) updateData.gstPercentage = Number(gstPercentage);
        if (taxInclusive !== undefined) updateData.taxInclusive = taxInclusive;
        if (tax !== undefined) updateData.tax = Number(tax);
        if (preparationTime !== undefined) updateData.preparationTime = preparationTime;
        if (kitchenCategory !== undefined) updateData.kitchenCategory = kitchenCategory;
        if (displayOrder !== undefined) updateData.displayOrder = displayOrder;
        if (spicyLevel !== undefined) updateData.spicyLevel = spicyLevel;
        if (isVeg !== undefined) updateData.isVeg = isVeg;
        if (isAvailable !== undefined) updateData.isAvailable = isAvailable;
        if (isFeatured !== undefined) updateData.isFeatured = isFeatured;
        if (isRecommended !== undefined) updateData.isRecommended = isRecommended;
        if (categoryId) updateData.categoryId = Number(categoryId);
        if (currentStock !== undefined) updateData.currentStock = Number(currentStock);
        if (minStock !== undefined) updateData.minStock = Number(minStock);
        if (maxStock !== undefined) updateData.maxStock = Number(maxStock);
        if (unit !== undefined) updateData.unit = unit;
        if (modifierOptions !== undefined) updateData.modifierOptions = modifierOptions;

        const item = await prisma.menuItem.update({
            where: {
                id: existingItem.id
            },
            data: updateData
        });

        // Replace / remove semantics: the OLD stored image is deleted only AFTER the
        // new image reference has been persisted successfully (never before).
        // Images still referenced by another menu item are kept.
        // Only runs when the request actually changed the image (never on a
        // partial update of other fields, which would otherwise delete the file).
        const oldPublicId = existingItem.imagePublicId;
        const newPublicId = updateData.imagePublicId != null ? updateData.imagePublicId : null;
        if (imageChanged && oldPublicId && oldPublicId !== newPublicId) {
            try {
                const referencedElsewhere = await isImageReferencedElsewhere(oldPublicId, existingItem.id);
                if (!referencedElsewhere) {
                    await storage.remove(oldPublicId);
                }
            } catch (err) {
                console.warn("⚠ Could not remove old menu item image:", err.message);
            }
        }

        res.status(200).json({
            success: true,
            item
        });

    } catch (error) {

        console.error(error);

        return errorResponse(
            res,
            error.message,
            error.statusCode || 500
        );
    }
};

const deleteMenuItem = async (req, res) => {
  try {

    const existingItem = await prisma.menuItem.findFirst({
      where: {
        id: Number(req.params.id),
        restaurantId: req.user.restaurantId
      }
    });

    if (!existingItem) {
      return errorResponse(res, "Menu item not found", 404);
    }

    await prisma.menuItem.delete({
      where: {
        id: existingItem.id
      }
    });

    // No orphaned images: remove the stored file once nothing else references it.
    if (existingItem.imagePublicId) {
      try {
        const referencedElsewhere = await isImageReferencedElsewhere(existingItem.imagePublicId, existingItem.id);
        if (!referencedElsewhere) {
          await storage.remove(existingItem.imagePublicId);
        }
      } catch (err) {
        console.warn("⚠ Could not remove menu item image:", err.message);
      }
    }

    res.json({
      success: true,
      message: "Menu item deleted"
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const toggleAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { isAvailable } = req.body;

    const existingItem = await prisma.menuItem.findFirst({
      where: {
        id: Number(id),
        restaurantId: req.user.restaurantId
      }
    });

    if (!existingItem) {
      return errorResponse(res, "Menu item not found", 404);
    }

    const item = await prisma.menuItem.update({
      where: { id: existingItem.id },
      data: { isAvailable: isAvailable !== false }
    });

    res.json({
      success: true,
      item
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const duplicateMenuItem = async (req, res) => {
  try {
    const { id } = req.params;

    const original = await prisma.menuItem.findFirst({
      where: {
        id: Number(id),
        restaurantId: req.user.restaurantId
      }
    });

    if (!original) {
      return errorResponse(res, "Menu item not found", 404);
    }

    const duplicate = await prisma.menuItem.create({
      data: {
        restaurantId: req.user.restaurantId,
        name: `${original.name} (Copy)`,
        shortName: original.shortName,
        sku: original.sku ? `${original.sku}-COPY` : '',
        barcode: '',
        description: original.description,
        shortDescription: original.shortDescription,
        image: original.image,
        imagePublicId: original.imagePublicId || null,
        imageIsExternal: original.imageIsExternal || false,
        images: original.images || [],
        price: original.price,
        costPrice: original.costPrice,
        gstPercentage: original.gstPercentage,
        taxInclusive: original.taxInclusive,
        tax: original.tax,
        preparationTime: original.preparationTime,
        kitchenCategory: original.kitchenCategory,
        displayOrder: original.displayOrder,
        spicyLevel: original.spicyLevel,
        isVeg: original.isVeg,
        isAvailable: true,
        isFeatured: false,
        isRecommended: false,
        categoryId: original.categoryId,
        currentStock: 0,
        minStock: original.minStock,
        maxStock: original.maxStock,
        unit: original.unit,
        modifierOptions: original.modifierOptions || ''
      }
    });

    res.status(201).json({
      success: true,
      data: duplicate,
      message: "Menu item duplicated successfully"
    });

  } catch (error) {return errorResponse(res, error.message);}
};

// ─── Image upload / delete (two-step flow: upload → reference → bind on save) ───

const uploadMenuItemImage = async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, "No file uploaded", 400);
    }
    // Validate ACTUAL content (magic bytes + full decode) — not just the filename/MIME.
    const { format } = await validateImageBuffer(req.file.buffer);
    // Resize + compress (never stored as uploaded; strips metadata).
    const processed = await processImage(req.file.buffer, format);
    const ext = format === "jpeg" ? "jpg" : format;
    const key = buildPublicId(req.user.restaurantId, ext);
    const result = await storage.upload(processed, {
      key,
      mimetype: req.file.mimetype
    });
    return successResponse(
      res,
      { imageUrl: result.url, imagePublicId: result.publicId },
      "Image uploaded successfully",
      201
    );
  } catch (error) {
    console.error(error);
    return errorResponse(res, error.message, error.statusCode || 400);
  }
};

const deleteMenuItemImage = async (req, res) => {
  try {
    const { imagePublicId } = req.body || {};
    if (!imagePublicId) {
      return errorResponse(res, "imagePublicId is required", 400);
    }
    // Multi-tenant guard: the image must belong to the caller's restaurant.
    const ownerRestaurantId = parseRestaurantId(imagePublicId);
    if (!ownerRestaurantId || ownerRestaurantId !== Number(req.user.restaurantId)) {
      return errorResponse(res, "You do not have permission to delete this image", 403);
    }
    // Refuse to delete images still bound to a menu item — bound images are
    // removed through the menu item update flow (image → null).
    const bound = await prisma.menuItem.count({ where: { imagePublicId } });
    if (bound > 0) {
      return errorResponse(res, "This image is attached to a menu item", 400);
    }
    const removed = await storage.remove(imagePublicId);
    return successResponse(res, { removed }, removed ? "Image deleted" : "Image not found");
  } catch (error) {
    console.error(error);
    return errorResponse(res, error.message, error.statusCode || 400);
  }
};

module.exports = {
  createMenuItem,
  getMenuItems,
  getMenuItemById,
  updateMenuItem,
  deleteMenuItem,
  toggleAvailability,
  duplicateMenuItem,
  uploadMenuItemImage,
  deleteMenuItemImage
};