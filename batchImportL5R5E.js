// Upsert compendium documents from a JSON URL WITHOUT deleting existing docs.
// - If _id exists in the target compendium: update it (in place).
// - If _id does not exist: import it (keepId:true).
// Nothing is deleted, so sheet references remain intact.

(async () => {
  // ========= CONFIG =========
  const FILE_URL = "https://raw.githubusercontent.com/JackBinary/potential-rotary-phone/refs/heads/main/l5r5e.core-bonds_Bonds.json";

  // Update mode:
  const PATCH_ONLY = true;  // true = update only specific fields below; false = replace whole doc
  const PATCH_PATHS = ["system.description"]; // fields to update when PATCH_ONLY=true

  const CHUNK = 25;
  const SHOW_TOASTS = true;
  const UNLOCK_IF_LOCKED = true;
  // ==========================

  const toast = (m, t="info") => SHOW_TOASTS && ui.notifications[t]?.(m);

  const getByPath = (obj, path) => {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[p];
    }
    return cur;
  };

  const setByPath = (obj, path, value) => {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  };

  // Build a minimal patch object that only contains PATCH_PATHS from source
  const buildPatch = (source, paths) => {
    const patch = {};
    for (const p of paths) {
      const v = getByPath(source, p);
      if (v !== undefined) setByPath(patch, p, v);
    }
    return patch;
  };

  // Fetch JSON
  let payload;
  try {
    const resp = await fetch(FILE_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    payload = await resp.json();
  } catch (e) {
    console.error("Fetch/parse failed", e);
    return toast(`Failed to fetch/parse JSON: ${e.message}`, "error");
  }

  if (!payload?.documents || !payload?.pack?.collection) {
    return toast("JSON missing 'documents' or 'pack.collection'.", "error");
  }

  const collection = payload.pack.collection;
  const pack = game.packs.get(collection);
  if (!pack) return toast(`Compendium not found: ${collection}`, "error");

  // Warnings only
  if (payload.pack.type && pack.documentName !== payload.pack.type) {
    console.warn(`Type mismatch: JSON=${payload.pack.type} vs Pack=${pack.documentName}`);
  }
  if (payload.pack.system && pack.metadata.system !== payload.pack.system) {
    console.warn(`System mismatch: JSON=${payload.pack.system} vs Pack=${pack.metadata.system}`);
  }

  if (pack.locked && UNLOCK_IF_LOCKED) {
    try {
      await pack.configure({ locked: false });
      toast(`Unlocked "${pack.metadata.label}" for updates.`);
    } catch (e) {
      console.warn("Could not unlock pack:", e);
    }
  }

  // Build an index of existing IDs for quick membership checks
  const index = await pack.getIndex();
  const existingIds = new Set(index.map(e => e._id));

  toast(`Upserting ${payload.documents.length} docs into "${pack.metadata.label}"...`);

  let updated = 0, created = 0, failed = 0;

  // Helper: create temp correct-class doc for import (when creating)
  async function buildTemp(raw) {
    const data = foundry.utils.duplicate(raw);
    return await pack.documentClass.create(data, { temporary: true });
  }

  // Process in batches
  for (let i = 0; i < payload.documents.length; i += CHUNK) {
    const slice = payload.documents.slice(i, i + CHUNK);

    // Split into updates vs creates
    const toUpdate = slice.filter(d => existingIds.has(d._id));
    const toCreate = slice.filter(d => !existingIds.has(d._id));

    // --- Updates (in-place) ---
    for (const d of toUpdate) {
      try {
        const doc = await pack.getDocument(d._id);
        if (!doc) {
          // Shouldn't happen since _id is in index, but guard anyway
          toCreate.push(d);
          continue;
        }
        if (PATCH_ONLY) {
          const patch = buildPatch(d, PATCH_PATHS);
          // Ensure we always send an _id for update
          patch._id = d._id;
          await doc.update(patch, { pack: pack.collection });
        } else {
          // Replace entire document data with the new content (keeping _id)
          // Avoid changing _id; Foundry ignores _id in the payload except to target the doc.
          await doc.update(d, { pack: pack.collection });
        }
        updated++;
      } catch (e) {
        failed++;
        console.error(`Update failed for ${d?.name ?? d?._id}`, e, d);
        toast(`Update failed: ${d?.name ?? d?._id}`, "warn");
      }
    }

    // --- Creates (no deletion) ---
    // Build temp docs first so Foundry uses correct class (e.g., ItemL5r5e)
    const temps = [];
    for (const d of toCreate) {
      try {
        const t = await buildTemp(d);
        temps.push(t);
      } catch (e) {
        failed++;
        console.error(`Temp create failed for "${d?.name ?? d?._id}"`, e, d);
        toast(`Temp create failed: ${d?.name ?? d?._id}`, "warn");
      }
    }
    for (const t of temps) {
      try {
        await pack.importDocument(t, { keepId: true });
        created++;
      } catch (e) {
        failed++;
        console.error(`Import failed for "${t?.name ?? t?.id}"`, e, t);
        toast(`Import failed: ${t?.name ?? t?.id}`, "warn");
      }
    }
  }

  await pack.getIndex({ reload: true });

  toast(`Upsert complete: ${updated} updated, ${created} created, ${failed} failed.`);
  console.log(`Upsert summary for ${collection}:`, { updated, created, failed });
})();
