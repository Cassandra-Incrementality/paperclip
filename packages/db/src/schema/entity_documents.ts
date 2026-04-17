import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { documents } from "./documents.js";

/**
 * `entity_documents` — polymorphic document store for diarization profiles.
 *
 * Each row links a `(entityType, entityId)` pair to a versioned document in
 * the `documents` table under a named key (e.g. "profile").
 *
 * Supported entity types: agent, project, goal, client, competitor, playbook.
 * No hard FK on entityId because entity types span multiple tables; companyId
 * is stored explicitly for efficient scoping and access checks.
 */
export const entityDocuments = pgTable(
  "entity_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entityKeyUq: uniqueIndex("entity_documents_entity_key_uq").on(
      table.companyId,
      table.entityType,
      table.entityId,
      table.key,
    ),
    documentUq: uniqueIndex("entity_documents_document_uq").on(table.documentId),
    companyEntityUpdatedIdx: index("entity_documents_company_entity_updated_idx").on(
      table.companyId,
      table.entityType,
      table.entityId,
      table.updatedAt,
    ),
  }),
);
