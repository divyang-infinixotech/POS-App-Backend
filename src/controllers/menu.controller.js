// tenantDb is available as req.tenantDb (attached by auth middleware)
const {
  storage,
  buildPublicId,
  parseRestaurantId,
  isOwnStorageUrl,
  isExternalUrl
} = require("../services/storage.service");
const { validateImageBuffer, processImage } = require("../services/image.service");

const { successResponse, errorResponse } = require("../utils/response");
const { dietaryMenuWhere, dietaryItemError, restaurantDietaryMode } = require("../utils/dietary");

/**
 * Load the restaurant's dietary mode from the TENANT settings (Part 16).
 * Falls back to VEG_AND_NON_VEG when the column is not migrated yet —
 * existing restaurants keep their current behavior.
 */
const getRestaurantDietaryMode = async (req) => {
  try {
    const setting = await req.tenantDb.restaurantSetting.findUnique({
      where: { restaurantId: req.user.restaurantId },
      select: { dietaryMode: true },
    });
    return restaurantDietaryMode(setting);
  } catch (err) {
    console.warn("[menu] dietaryMode read failed, defaulting to VEG_AND_NON_VEG:", err.message);
    return "VEG_AND_NON_VEG";
  }
};

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
const isImageReferencedElsewhere = async (db, publicId, excludeItemId) => {
  if (!db) return false;
  const count = await db.menuItem.count({
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
      dietaryType,
      subcategoryId,
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

    const category = await req.tenantDb.category.findFirst({

      where: {

        id: Number(categoryId)

      }

    });

    if (!category) {

      return errorResponse(

        res,

        "Category not found",

        404

      );

    }

    // Subcategory (Part 16): optional, but if given it must belong to the
    // selected category — a cross-category reference is rejected.
    let subcategoryIdValue = null;
    if (subcategoryId != null && subcategoryId !== "") {
      const sub = await req.tenantDb.subcategory.findFirst({
        where: { id: Number(subcategoryId), categoryId: Number(categoryId) },
      });
      if (!sub) {
        // Part 12: a subcategory that exists but belongs to another category is a
        // client validation error → 400 (not 404).
        return errorResponse(res, "Subcategory does not belong to the selected category.", 400);
      }
      subcategoryIdValue = sub.id;
    }

    // Dietary type (Part 8/16): explicit value wins; fall back to legacy isVeg.
    // A VEG_ONLY restaurant can never create NON_VEG items — the request is
    // rejected with the same canonical 400 the update path uses (no silent
    // coercion: callers must know the item was not created as submitted).
    let dietaryTypeValue = dietaryType === "NON_VEG" || dietaryType === "VEG"
      ? dietaryType
      : (isVeg === false ? "NON_VEG" : "VEG");
    if (dietaryTypeValue === "NON_VEG" && (await getRestaurantDietaryMode(req)) === "VEG_ONLY") {
      return errorResponse(res, "This restaurant is configured for Veg Only — items cannot be set to Non-Veg.", 400);
    }
    const isVegValue = dietaryTypeValue === "VEG";

    // Barcode uniqueness within the tenant (Part 11). An empty/absent barcode
    // means "no barcode" and is always allowed; a present one must not collide
    // with another item in THIS restaurant only.
    const normalizedBarcode = barcode != null ? String(barcode).trim() : "";
    if (normalizedBarcode) {
      const barcodeClash = await req.tenantDb.menuItem.findFirst({
        where: { restaurantId: req.user.restaurantId, barcode: normalizedBarcode },
        select: { id: true, name: true },
      });
      if (barcodeClash) {
        return errorResponse(res, `Barcode already in use by item "${barcodeClash.name}".`, 400);
      }
    }

    const imageData = sanitizeImageInput({
      image,
      imagePublicId,
      existingItem: null,
      restaurantId: req.user.restaurantId
    });

    const menuItem = await req.tenantDb.menuItem.create({
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

        isVeg: isVegValue,

        dietaryType: dietaryTypeValue,

        subcategoryId: subcategoryIdValue,

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

    // Dietary access (Parts 5/10/15): effective access = restaurant mode +
    // staff access — a VEG_ONLY restaurant or VEG_ONLY user can never receive
    // NON_VEG items, server-side, regardless of URL tampering/filters.
    const where = { ...(await dietaryMenuWhere(req)) };

    // Part 17 filters — all optional, combined with the dietary constraint.
    const { categoryId, subcategoryId, dietaryType, availability, search } = req.query;
    if (categoryId) where.categoryId = Number(categoryId);
    if (subcategoryId) where.subcategoryId = Number(subcategoryId);
    if (dietaryType === "VEG" || dietaryType === "NON_VEG") {
      // A restricted caller can never widen their access via this filter.
      if (where.dietaryType !== "VEG") where.dietaryType = dietaryType;
    }
    if (availability === "true") where.isAvailable = true;
    if (availability === "false") where.isAvailable = false;
    if (search) {
      where.OR = [
        { name: { contains: String(search) } },
        { sku: { contains: String(search) } },
      ];
    }

    const items = await req.tenantDb.menuItem.findMany({
      where,
      include: {
        category: true,
        subcategory: true,
      },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    });

    res.json({
      success: true,
      items
    });
  } catch (error) {return errorResponse(res, error.message);}
};

const getMenuItemById = async (req, res) => {
  try {    const item = await req.tenantDb.menuItem.findFirst({
      where: {
        id: Number(req.params.id)
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
            dietaryType,
            subcategoryId,
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

        const existingItem = await req.tenantDb.menuItem.findFirst({
            where: {
                id: Number(id)
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

            const category = await req.tenantDb.category.findFirst({
                where: {
                    id: Number(categoryId)
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

        const updateData = {};

        // Subcategory (Part 16): optional on update too. When a new category is
        // set, a stale subcategory from the previous category is reset (Part 16:
        // "changing category must reset an invalid subcategory").
        if (subcategoryId !== undefined) {
            if (subcategoryId === null || subcategoryId === "") {
                updateData.subcategoryId = null;
            } else {
                const targetCategoryId = categoryId ? Number(categoryId) : existingItem.categoryId;
                const sub = await req.tenantDb.subcategory.findFirst({
                    where: { id: Number(subcategoryId), categoryId: targetCategoryId },
                });
                if (!sub) {
                    return errorResponse(res, "Subcategory does not belong to the selected category.", 400);
                }
                updateData.subcategoryId = sub.id;
            }
        } else if (categoryId && existingItem.subcategoryId) {
            const subStillValid = await req.tenantDb.subcategory.findFirst({
                where: { id: existingItem.subcategoryId, categoryId: Number(categoryId) },
            });
            if (!subStillValid) updateData.subcategoryId = null;
        }

        // Dietary type (Part 8/16): explicit dietaryType wins; keep isVeg in sync.
        // A VEG_ONLY restaurant can never (re)classify an item as NON_VEG.
        const wantsNonVeg = dietaryType === "NON_VEG" || (dietaryType === undefined && isVeg === false);
        if (dietaryType !== undefined || isVeg !== undefined) {
            if (wantsNonVeg && (await getRestaurantDietaryMode(req)) === "VEG_ONLY") {
                return errorResponse(res, "This restaurant is configured for Veg Only — items cannot be set to Non-Veg.", 400);
            }
            if (dietaryType !== undefined) {
                if (dietaryType !== "VEG" && dietaryType !== "NON_VEG") {
                    return errorResponse(res, "dietaryType must be VEG or NON_VEG.", 400);
                }
                updateData.dietaryType = dietaryType;
                updateData.isVeg = dietaryType === "VEG";
            } else {
                updateData.dietaryType = isVeg ? "VEG" : "NON_VEG";
                updateData.isVeg = !!isVeg;
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

        if (name !== undefined) updateData.name = name;
        if (shortName !== undefined) updateData.shortName = shortName;
        if (sku !== undefined) updateData.sku = sku;
        if (barcode !== undefined) {
            // Barcode uniqueness within the tenant (Part 11). Empty string =
            // "no barcode" and is always allowed. The item's own barcode is
            // naturally excluded (id not-equal check below).
            const normalizedBarcode = barcode != null ? String(barcode).trim() : "";
            if (normalizedBarcode) {
                const barcodeClash = await req.tenantDb.menuItem.findFirst({
                    where: {
                        restaurantId: req.user.restaurantId,
                        barcode: normalizedBarcode,
                        id: { not: existingItem.id },
                    },
                    select: { id: true, name: true },
                });
                if (barcodeClash) {
                    return errorResponse(res, `Barcode already in use by item "${barcodeClash.name}".`, 400);
                }
            }
            updateData.barcode = normalizedBarcode;
        }
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

        const item = await req.tenantDb.menuItem.update({
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
                const referencedElsewhere = await isImageReferencedElsewhere(req.tenantDb, oldPublicId, existingItem.id);
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

    const existingItem = await req.tenantDb.menuItem.findFirst({
      where: {
        id: Number(req.params.id)
      }
    });

    if (!existingItem) {
      return errorResponse(res, "Menu item not found", 404);
    }

    await req.tenantDb.menuItem.delete({
      where: {
        id: existingItem.id
      }
    });

    // No orphaned images: remove the stored file once nothing else references it.
    if (existingItem.imagePublicId) {
      try {
        const referencedElsewhere = await isImageReferencedElsewhere(req.tenantDb, existingItem.imagePublicId, existingItem.id);
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

    const existingItem = await req.tenantDb.menuItem.findFirst({
      where: {
        id: Number(id)
      }
    });

    if (!existingItem) {
      return errorResponse(res, "Menu item not found", 404);
    }

    const item = await req.tenantDb.menuItem.update({
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

    const original = await req.tenantDb.menuItem.findFirst({
      where: {
        id: Number(id)
      }
    });

    if (!original) {
      return errorResponse(res, "Menu item not found", 404);
    }

    const duplicate = await req.tenantDb.menuItem.create({
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
        dietaryType: original.dietaryType,
        subcategoryId: original.subcategoryId,
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
    const referenced = await req.tenantDb.menuItem.count({ where: { imagePublicId } });
    if (referenced > 0) {
      return errorResponse(res, "This image is attached to a menu item", 400);
    }
    const removed = await storage.remove(imagePublicId);
    return successResponse(res, { removed }, removed ? "Image deleted" : "Image not found");
  } catch (error) {
    console.error(error);
    return errorResponse(res, error.message, error.statusCode || 400);
  }
};

// ─── Barcode scanner lookup (Part 11) ──────────────────────────────────────
/**
 * GET /api/menu/barcode/:barcode
 *
 * Resolves ONE sellable menu item by barcode for the CURRENT tenant only:
 *   - authenticated + tenant-scoped via req.tenantDb (never another tenant's
 *     MenuItem table)
 *   - plan entitlement (requireFeature "barcode_scanner") + restaurant scanner
 *     toggle enforced by route middleware BEFORE this handler runs
 *   - only ACTIVE/available items are returned (isAvailable = true)
 *   - 404 with an explicit message when nothing matches — callers must show
 *     "Item not found for barcode: ...", never silently guess
 */
const getMenuItemByBarcode = async (req, res) => {
  try {
    const barcode = String(req.params.barcode || "").trim();
    if (!barcode) return errorResponse(res, "Barcode is required", 400);
    if (!req.user.restaurantId) {
      return errorResponse(res, "Restaurant context missing", 403);
    }
    // Tenant-level scanner toggle (Part 11): plan entitlement is the upper
    // limit (requireFeature middleware); the restaurant can still keep the
    // scanner OFF. Missing row/column → default OFF (safe default, scanner
    // only works when explicitly enabled).
    if (req.user.role !== "SUPER_ADMIN") {
      try {
        const setting = await req.tenantDb.restaurantSetting.findFirst({
          where: { restaurantId: req.user.restaurantId },
          select: { barcodeScannerEnabled: true },
        });
        if (!setting || setting.barcodeScannerEnabled !== true) {
          return errorResponse(res, "Barcode scanner is not enabled for this restaurant.", 403);
        }
      } catch (settingErr) {
        // Column not migrated yet → treat as disabled (safe default).
        return errorResponse(res, "Barcode scanner is not enabled for this restaurant.", 403);
      }
    }
    // Tenant-scoped lookup against the caller's own MenuItem table.
    // Empty-string barcodes mean "no barcode" and can never be scanned.
    const item = await req.tenantDb.menuItem.findFirst({
      where: {
        restaurantId: req.user.restaurantId,
        barcode: barcode,
        isAvailable: true,
      },
      include: { category: { select: { id: true, name: true } } },
      take: 1,
    });
    if (!item) {
      return errorResponse(res, `Item not found for barcode: ${barcode}`, 404);
    }
    return successResponse(res, { item }, "Menu item fetched by barcode");
  } catch (error) {
    console.error("[menu] getMenuItemByBarcode error:", error.message);
    return errorResponse(res, error.message);
  }
};

// ─── Subcategories (Part 13–15) ─────────────────────────────────────────────
/**
 * GET /api/menu/subcategories?categoryId=
 * Tenant-scoped list. Optional categoryId narrows to one category.
 */
const getSubcategories = async (req, res) => {
  try {
    const where = {};
    if (req.query.categoryId) where.categoryId = Number(req.query.categoryId);
    const subcategories = await req.tenantDb.subcategory.findMany({
      where,
      include: { category: { select: { id: true, name: true } } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    return successResponse(res, { subcategories }, "Subcategories fetched successfully");
  } catch (error) { return errorResponse(res, error.message); }
};

/**
 * POST /api/menu/subcategories
 * Body: { categoryId, name, description?, sortOrder?, isActive? }
 */
const createSubcategory = async (req, res) => {
  try {
    const { categoryId, name, description, sortOrder, isActive } = req.body;
    if (!name || !String(name).trim()) {
      return errorResponse(res, "Subcategory name is required.", 400);
    }
    if (!categoryId) return errorResponse(res, "categoryId is required.", 400);
    const category = await req.tenantDb.category.findFirst({ where: { id: Number(categoryId) } });
    if (!category) return errorResponse(res, "Category not found", 404);

    const subcategory = await req.tenantDb.subcategory.create({
      data: {
        restaurantId: req.user.restaurantId,
        categoryId: Number(categoryId),
        name: String(name).trim(),
        description: description || null,
        sortOrder: sortOrder != null ? Number(sortOrder) : 0,
        isActive: isActive !== false,
      },
    });
    return successResponse(res, { subcategory }, "Subcategory created successfully", 201);
  } catch (error) { return errorResponse(res, error.message); }
};

/**
 * PUT /api/menu/subcategories/:id
 * Body: any of { name, description, sortOrder, isActive, categoryId }
 */
const updateSubcategory = async (req, res) => {
  try {
    const existing = await req.tenantDb.subcategory.findFirst({ where: { id: Number(req.params.id) } });
    if (!existing) return errorResponse(res, "Subcategory not found", 404);

    const { name, description, sortOrder, isActive, categoryId } = req.body;
    const data = {};
    if (name !== undefined) {
      if (!String(name).trim()) return errorResponse(res, "Subcategory name is required.", 400);
      data.name = String(name).trim();
    }
    if (description !== undefined) data.description = description || null;
    if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);
    if (isActive !== undefined) data.isActive = isActive !== false;
    if (categoryId !== undefined && Number(categoryId) !== existing.categoryId) {
      const category = await req.tenantDb.category.findFirst({ where: { id: Number(categoryId) } });
      if (!category) return errorResponse(res, "Category not found", 404);
      data.categoryId = Number(categoryId);
    }

    const subcategory = await req.tenantDb.subcategory.update({ where: { id: existing.id }, data });
    return successResponse(res, { subcategory }, "Subcategory updated successfully");
  } catch (error) { return errorResponse(res, error.message); }
};

/**
 * DELETE /api/menu/subcategories/:id?moveToSubcategoryId=<id|"none">
 * Part 15: active items are never orphaned — they must be reassigned first
 * (move to another subcategory or set to None).
 */
const deleteSubcategory = async (req, res) => {
  try {
    const existing = await req.tenantDb.subcategory.findFirst({ where: { id: Number(req.params.id) } });
    if (!existing) return errorResponse(res, "Subcategory not found", 404);

    const itemCount = await req.tenantDb.menuItem.count({ where: { subcategoryId: existing.id } });
    if (itemCount > 0) {
      const moveTo = req.query.moveToSubcategoryId;
      if (moveTo === undefined || moveTo === "") {
        return errorResponse(
          res,
          `This subcategory still has ${itemCount} menu item(s). Reassign them first (move to another subcategory or set to None).`,
          400
        );
      }
      if (moveTo === "none") {
        await req.tenantDb.menuItem.updateMany({ where: { subcategoryId: existing.id }, data: { subcategoryId: null } });
      } else {
        const target = await req.tenantDb.subcategory.findFirst({
          where: { id: Number(moveTo) },
        });
        if (!target) return errorResponse(res, "Target subcategory not found", 404);
        if (target.id === existing.id) return errorResponse(res, "Cannot move items to the subcategory being deleted.", 400);
        await req.tenantDb.menuItem.updateMany({ where: { subcategoryId: existing.id }, data: { subcategoryId: target.id } });
      }
    }

    await req.tenantDb.subcategory.delete({ where: { id: existing.id } });
    return successResponse(res, null, "Subcategory deleted successfully");
  } catch (error) { return errorResponse(res, error.message); }
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
  deleteMenuItemImage,
  getMenuItemByBarcode,
  getSubcategories,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory
};