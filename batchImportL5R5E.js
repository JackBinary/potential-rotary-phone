// batchUpsertL5R5E.js
// Legend of the Five Rings (L5R5e) Compendium batch UPSERT importer.
// Updates existing docs in place, adds new ones, never deletes (so Actor links stay intact).

(() => {
  const VERSION = "1.0-upsert";

  if (window.__L5R5E_BATCH_RUNNING__) {
    console.warn("[L5R5E] batch upsert already running");
    return;
  }
  window.__L5R5E_BATCH_RUNNING__ = true;

  window.L5R5E = window.L5R5E || {};

  const DEFAULTS = {
    BASE_URL: "https://raw.githubusercontent.com/JackBinary/potential-rotary-phone/refs/heads/main/",
    FILES: [
      "l5r5e.core-bonds_Bonds.json",
      "l5r5e.core-peculiarities-adversities_Adversities.json",
      "l5r5e.core-peculiarities-anxieties_Anxieties.json",
      "l5r5e.core-peculiarities-distinctions_Distinctions.json",
      "l5r5e.core-peculiarities-passions_Passions.json",
      "l5r5e.core-techniques-inversions_Techniques_Inversions.json",
      "l5r5e.core-techniques-invocations_Techniques_Invocations.json",
      "l5r5e.core-techniques-kata_Techniques_Kata.json",
      "l5r5e.core-techniques-kiho_Techniques_Kih_.json",
      "l5r5e.core-techniques-maho_Techniques_Mah_.json",
      "l5r5e.core-techniques-mantra_Techniques_Mantra.json",
      "l5r5e.core-techniques-mastery_Mastery_Abilities.json",
      "l5r5e.core-techniques-ninjutsu_Techniques_Ninjutsu.json",
      "l5r5e.core-techniques-rituals_Techniques_Rituals.json",
      "l5r5e.core-techniques-school_School_Abilities.json",
      "l5r5e.core-techniques-shuji_Techniques_Shuji.json",
      "l5r5e.core-titles_Titles.json",
    ],
    PATCH_ONLY: true,
    PATCH_PATHS: ["system.description"],
    CHUNK: 25,
    UNLOCK_IF_LOCKED: true,
    SHOW_TOASTS: true,
    SLEEP_BETWEEN_FILES: 300
  };

  const toast = (m,t="info",cfg=DEFAULTS)=>cfg.SHOW_TOASTS&&ui.notifications[t]?.(m);
  const sleep = ms => new Promise(r=>setTimeout(r,ms));

  const getByPath=(obj,p)=>p.split(".").reduce((a,c)=>a?.[c],obj);
  const setByPath=(obj,p,v)=>p.split(".").reduce((a,c,i,arr)=>(i===arr.length-1?a[c]=v:(a[c]??={}),a[c]),obj);
  const buildPatch=(src,paths)=>{const o={};for(const p of paths){const v=getByPath(src,p);if(v!==undefined)setByPath(o,p,v);}return o;};

  async function processFile(fname,cfg){
    const url=cfg.BASE_URL+fname;
    toast(`Fetching ${fname}…`,"info",cfg);
    let payload;
    try{
      const r=await fetch(url,{cache:"no-store"});
      if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
      payload=await r.json();
    }catch(e){console.error("[L5R5E] Fetch fail",e);toast(`Fetch failed: ${fname}`,"error",cfg);return {file:fname,status:"fetch-failed"};}

    if(!payload?.documents||!payload?.pack?.collection){toast(`Invalid JSON in ${fname}`,"error",cfg);return {file:fname,status:"bad-json"};}
    const collection=payload.pack.collection;
    const pack=game.packs.get(collection);
    if(!pack){toast(`Pack missing: ${collection}`,"error",cfg);return {file:fname,status:"no-pack"};}

    if(pack.locked&&cfg.UNLOCK_IF_LOCKED){try{await pack.configure({locked:false});toast(`Unlocked ${pack.metadata.label}`,"info",cfg);}catch(e){console.warn("Unlock failed",e);}}

    const index=await pack.getIndex();const existing=new Set(index.map(e=>e._id));
    let updated=0,created=0,failed=0;

    const buildTemp=async d=>pack.documentClass.create(foundry.utils.duplicate(d),{temporary:true});

    for(let i=0;i<payload.documents.length;i+=cfg.CHUNK){
      const slice=payload.documents.slice(i,i+cfg.CHUNK);
      for(const d of slice){
        try{
          if(existing.has(d._id)){
            const doc=await pack.getDocument(d._id);
            if(!doc)continue;
            if(cfg.PATCH_ONLY){const patch=buildPatch(d,cfg.PATCH_PATHS);patch._id=d._id;await doc.update(patch,{pack:pack.collection});}
            else await doc.update(d,{pack:pack.collection});
            updated++;
          }else{
            const tmp=await buildTemp(d);
            await pack.importDocument(tmp,{keepId:true});
            created++;
          }
        }catch(e){failed++;console.error(`[L5R5E] Upsert fail for ${d?.name}`,e);toast(`Fail: ${d?.name}`,"warn",cfg);}
      }
    }
    await pack.getIndex({reload:true});
    toast(`${pack.metadata.label}: ${updated} updated, ${created} created, ${failed} failed`,"info",cfg);
    return {file:fname,updated,created,failed};
  }

  async function main(opts={}){
    const cfg=Object.assign({},DEFAULTS,opts);
    const results=[];
    console.info(`[L5R5E] Batch UPSERT v${VERSION} starting…`);
    for(const f of cfg.FILES){
      results.push(await processFile(f,cfg));
      await sleep(cfg.SLEEP_BETWEEN_FILES);
    }
    console.table(results);
    toast("Batch upsert done — see console for summary","info",cfg);
    window.__L5R5E_BATCH_RUNNING__=false;
    return results;
  }

  window.L5R5E.batchUpsert=main;
  main();
})();
