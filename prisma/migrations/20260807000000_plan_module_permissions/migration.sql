-- CreateTable
CREATE TABLE "PlanModule" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'package',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanModule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanModule_key_key" ON "PlanModule"("key");

-- CreateIndex
CREATE INDEX "PlanModule_isActive_idx" ON "PlanModule"("isActive");

-- CreateIndex
CREATE INDEX "PlanModule_key_idx" ON "PlanModule"("key");

-- CreateTable
CREATE TABLE "PlanModulePermission" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "moduleId" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanModulePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanModulePermission_planId_moduleId_key" ON "PlanModulePermission"("planId", "moduleId");

-- CreateIndex
CREATE INDEX "PlanModulePermission_moduleId_idx" ON "PlanModulePermission"("moduleId");

-- CreateIndex
CREATE INDEX "PlanModulePermission_planId_idx" ON "PlanModulePermission"("planId");

-- AddForeignKey
ALTER TABLE "PlanModulePermission" ADD CONSTRAINT "PlanModulePermission_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanModulePermission" ADD CONSTRAINT "PlanModulePermission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "PlanModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
