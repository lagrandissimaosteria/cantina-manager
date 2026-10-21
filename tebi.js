/* tebi.js — Sincronizzazione cassa Tebi (sezione in Export & Bilancio).
Flusso: export prodotti da Tebi (.xlsx) → caricato qui → fusione con vini in carta + prodotti Bar →
riepilogo e conferma abbinamenti dubbi → scarica il file completo da reimportare in Tebi (Prodotti → Importa).
Regole: le righe Tebi non abbinate (cibo, coperto, voci generiche) escono IDENTICHE, colonna per colonna;
le righe abbinate cambiano solo prezzo, costo netto, SKU e (se archiviate) stato. Nessun dato del gestionale viene modificato.
Dipende da manager.js (wines, movements, CONFIG, h, fmt, fmtN, ic, notify, render, today, XLSX; per le vendite: uid, calcCostoIvaBottiglia, _caliciPiano, _applyMovEffect, _fifoShort, _servizioSnap, scheduleSave, _flushSave) e, se presente, bar.js (_barProdotti, ORD_CAT). */
"use strict";
var tebiUi = { rows:null, header:null, file:"", plan:null, conf:{}, arch:{}, cat:{}, off:{} };

const _tbNorm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g," ").trim();
const _TB_STOP = new Set(["di","del","della","delle","dei","degli","da","al","alla","the","and","con","per","vino","vini","calice","bottiglia","doc","docg","igt","igp","aoc","dop"]);
const _tbTok = s => new Set(_tbNorm(s).split(" ").filter(t=>t.length>=3 && !_TB_STOP.has(t)));
const _tbHash = s => { let x=5381; for(const c of String(s)) x=((x<<5)+x+c.charCodeAt(0))>>>0; return x.toString(36).toUpperCase(); };
const _tbNum = v => { const n=parseFloat(String(v??"").replace(",",".")); return isFinite(n)? n : 0; };
const _tbR2 = n => Math.round(n*100)/100;
const _tbTags = r => String(r.TAGS||"").split(",").map(s=>s.trim().toLowerCase());

// ─── Prodotti del gestionale da mandare in cassa ─────────────────────────────
function _tbFmtL(w){ const f=_tbNum(w.formato)||0.75; return f!==0.75? " "+String(f).replace(".",",")+"L" : ""; }
const _TB_DOSE_TIP = /^(amaro|amari|vermouth|distillato|grappa|liquore|whisky|rum|rhum|gin|brandy|cognac|armagnac|calvados|acquavite|bitter)$/i;
const _TB_DOSE_NOME = /\b(amaro|vermouth|grappa|genziana|liquore|whisk(e)?y|rhum|cognac|armagnac|calvados|acquavite|mirto|fernet|bitter|china)\b/i;
function _tbSoloDose(w){ return _TB_DOSE_TIP.test(String(w.tipologia||"").trim()) || (_TB_DOSE_NOME.test(String(w.nome||"")) && !/chinato/i.test(String(w.nome||""))); }
function _tbProdottiCM(){
  const out = [];
  (typeof wines!=="undefined"? wines : []).forEach(w=>{
    const g = parseInt(w.giacenza)||0, pc = _tbNum(w.prezzoCarta);
    if(pc<=0) return;                                           // senza prezzo carta non va in cassa
    const esaurito = g<=0;                                      // esauriti: servono solo per archiviarli in cassa
    const ann = /^\d{4}$/.test(String(w.annata||"").trim())? String(w.annata).trim() : "";
    const base = [w.nome, w.produttore, ann].filter(Boolean).join(" ").replace(/\s+/g," ").trim() + _tbFmtL(w);
    const sku = w.sku || ("W-"+_tbHash(w.id)), cal = _tbNum(w.prezzoCalice);
    // Amari, vermouth, distillati in cantina: in cassa SOLO a dose (prezzo calice), mai al prezzo bottiglia.
    // Senza prezzo calice il prezzo in Tebi resta quello che c'è (prezzo:null).
    if(_tbSoloDose(w)){ out.push({ gid:"w:"+w.id, grp:"spirits", dose:true, sku, nome:base, prezzo:cal>0? cal : null, costo:0, esaurito, fonte:w }); return; }
    out.push({ gid:"w:"+w.id, grp:"vini", sku, nome:base, prezzo:pc, costo:_tbR2(_tbNum(w.prezzoAcq)), esaurito, fonte:w });
    if(cal>0) out.push({ gid:"wc:"+w.id, grp:"calici", sku:sku+"-C", nome:"Calice "+base, prezzo:cal, costo:0, esaurito, fonte:w });
  });
  if(typeof _barProdotti==="function"){
    const prods = _barProdotti(), ix = (typeof _barIndex==="function")? _barIndex(prods) : null;
    prods.forEach(p=>{
      if(p.inArrivo || p.uso==="cocktail" || p.uso==="mixer") return;
      const prezzo = _tbNum(p.prezzo); if(prezzo<=0) return;
      let esaurito = !p.attivo;
      try{ if(!esaurito && ix && ix.get(p.id)) esaurito = _barGiac(ix.get(p.id), today()).g <= 0.001; }catch{}
      const grp = p.cat==="spirits"? "spirits" : p.cat==="sodati"? "sodati" : "birre"; // birre, kegvino, kegcocktail
      const nome = [p.nome, p.produttore].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
      out.push({ gid:"b:"+p.key, grp, sku:"BAR-"+_tbHash(p.key), nome, prezzo, costo:_tbR2(_tbNum(p.costoNet)*(p.unita==="dose"||p.unita==="bicchiere"? 1/(p.dosi||1) : 1)), esaurito, fonte:p });
      if(p.unita==="bicchiere" && _tbNum(p.prezzoPiccola)>0 && p.cat==="birre")
        out.push({ gid:"bp:"+p.key, grp, sku:"BAR-"+_tbHash(p.key)+"-P", nome:nome+" piccola", prezzo:_tbNum(p.prezzoPiccola), costo:0, esaurito, fonte:p });
    });
  }
  return out;
}
const TB_CAT_DEF = { sodati:"Analcolici artigianali" }; // categoria report di default per i prodotti nuovi
const TB_GRP = { vini:"Vini (bottiglia)", calici:"Vini al calice", spirits:"Spirits e amari", birre:"Birre e spina", sodati:"Sodati e analcolici" };

// ─── Righe modello per i prodotti nuovi (copiano reparto, portata, IVA, tag) ─
function _tbTemplate(rows, grp){
  const act = rows.filter(r=>r.STATUS!=="ARCHIVED");
  const by = re => act.find(r=>re.test(_tbNorm(r.NAME)));
  const tag = t => act.find(r=>_tbTags(r).includes(t));
  const cat = c => act.filter(r=>r.REPORTING_CATEGORY===c).find(r=>_tbNum(r.DISPLAY_SALES_PRICE)>0);
  if(grp==="vini") return by(/^bottiglia vino/) || tag("wine") || cat("Bevande");
  if(grp==="calici") return by(/^calice vino/) || by(/^calice/) || tag("wine") || cat("Bevande");
  if(grp==="spirits") return cat("Amari e Distillati") || by(/^distillati|^amaro$/) || tag("alcoholic");
  if(grp==="birre") return by(/^birra$/) || by(/^birra/) || cat("Bevande");
  return by(/^bibite/) || by(/^molecola|^cola/) || cat("Bevande");
}
const _TB_RESET = { GTIN:null, NAME:null, SHORT_NAME:null, SKU:null, DESCRIPTION:null, DISPLAY_SALES_PRICE:null, NET_PURCHASE_PRICE:null,
  STATUS:"ACTIVE", TOP_ITEMS_POSITION:null, EVENT_ITEMS_POSITION:null, IMAGE_REFERENCE:null, PREP_NAME:null, PROMPT_PRICE_AT_SALE_TIME:false,
  INVENTORY_TRACKING:false, COMPONENTS:null, MODIFIER_ONLY:false, IS_GIFT_CARD:false };

// ─── Abbinamento ─────────────────────────────────────────────────────────────
function _tbPiano(rows){
  const cm = _tbProdottiCM().sort((a,b)=>(a.esaurito?1:0)-(b.esaurito?1:0)), used = new Set(), match = new Map(), dubbi = []; // disponibili prima degli esauriti
  const elig = rows.map((r,i)=>({ r, i, n:_tbNorm(r.NAME), tok:_tbTok(r.NAME), sku:String(r.SKU||"").trim() }));
  const take = (c, e, tipo, score) => { used.add(e.i); match.set(c.gid, { i:e.i, tipo, score }); };
  // 1) SKU scritto da un sync precedente  2) nome identico (preferisce le righe attive)
  const ord = arr => arr.sort((a,b)=>(a.r.STATUS==="ARCHIVED")-(b.r.STATUS==="ARCHIVED"));
  cm.forEach(c=>{ const e=ord(elig.filter(e=>!used.has(e.i) && e.sku && e.sku===c.sku))[0]; if(e) take(c,e,"sku",1); });
  cm.forEach(c=>{ if(match.has(c.gid)) return; const n=_tbNorm(c.nome); const e=ord(elig.filter(e=>!used.has(e.i) && e.n===n))[0]; if(e) take(c,e,"nome",1); });
  // 3) somiglianza: almeno 2 parole significative in comune → da confermare
  const cand = [];
  cm.forEach(c=>{ if(match.has(c.gid)) return; const A=_tbTok(c.nome); if(A.size<2) return;
    elig.forEach(e=>{ if(used.has(e.i) || e.sku || e.tok.size<2) return;
      let k=0; A.forEach(t=>{ if(e.tok.has(t)) k++; }); if(k<2) return;
      const s = k/Math.min(A.size, e.tok.size); if(s>=0.6) cand.push({ c, e, s }); }); });
  cand.sort((a,b)=>b.s-a.s).forEach(({c,e,s})=>{ if(match.has(c.gid) || used.has(e.i)) return; take(c,e,"simile",s); dubbi.push(c.gid); });
  // Righe Tebi con SKU del gestionale ma prodotto non più in carta / esaurito
  const skuCM = new Set(cm.map(c=>c.sku));
  const orfani = elig.filter(e=>!used.has(e.i) && /^(?:[A-Z]{1,3}-\d|W-|BAR-)/.test(e.sku) && !skuCM.has(e.sku) && e.r.STATUS!=="ARCHIVED").map(e=>e.i);
  return { cm, match, dubbi, orfani };
}

// ─── Fusione ─────────────────────────────────────────────────────────────────
function _tbFondi(){
  const { rows, plan } = tebiUi, out = rows.map(r=>({...r})), log = { prezzi:[], nuovi:[], riattivati:[], archiviati:[], invariati:0, sku:0 };
  const tocc = new Set();
  plan.cm.forEach(c=>{
    if(tebiUi.off[c.grp]) return;
    const m = plan.match.get(c.gid), ok = m && (m.tipo!=="simile" || tebiUi.conf[c.gid]);
    if(c.esaurito){                                             // esaurito: mai creato, mai riprezzato; solo archiviato se confermato
      if(ok && tebiUi.arch[m.i]!==false && out[m.i].STATUS!=="ARCHIVED"){ out[m.i].STATUS="ARCHIVED"; out[m.i].SKU=c.sku; tocc.add(m.i); log.archiviati.push(out[m.i].NAME); }
      return;
    }
    if(ok){
      const r = out[m.i]; tocc.add(m.i);
      const old = _tbNum(r.DISPLAY_SALES_PRICE);
      // riga venduta a dose in cassa ma prodotto del gestionale a bottiglia: il prezzo bottiglia non entra mai
      const prezzo = (r.REPORTING_CATEGORY==="Amari e Distillati" && c.grp==="vini")? null : c.prezzo;
      if(prezzo!=null && Math.abs(old-prezzo)>0.004) log.prezzi.push({ nome:r.NAME, da:old, a:prezzo });
      if(r.STATUS==="ARCHIVED"){ r.STATUS="ACTIVE"; log.riattivati.push(r.NAME); }
      if(String(r.SKU||"")!==c.sku) log.sku++;
      r.SKU = c.sku;
      if(prezzo!=null){ r.DISPLAY_SALES_PRICE = prezzo; r.PROMPT_PRICE_AT_SALE_TIME = false; }
      if(c.costo>0 && prezzo!=null) r.NET_PURCHASE_PRICE = c.costo;
    } else {
      if(c.prezzo==null) return;                                  // a dose senza prezzo calice: non si crea
      const t = _tbTemplate(rows, c.grp); if(!t) return;
      const r = { ...t, ..._TB_RESET, NAME:c.nome, SKU:c.sku, DISPLAY_SALES_PRICE:c.prezzo, NET_PURCHASE_PRICE:c.costo||0 };
      const cat = String(tebiUi.cat[c.grp] ?? TB_CAT_DEF[c.grp] ?? "").trim(); if(cat) r.REPORTING_CATEGORY = cat;
      out.push(r); log.nuovi.push({ nome:c.nome, prezzo:c.prezzo, grp:c.grp });
    }
  });
  plan.orfani.forEach(i=>{ if(tebiUi.arch[i]){ out[i].STATUS="ARCHIVED"; tocc.add(i); log.archiviati.push(out[i].NAME); } });
  log.invariati = rows.length - tocc.size;
  return { out, log };
}
// Righe non toccate devono restare identiche: controllo prima di scaricare
function _tbVerifica(out){
  const { rows, plan } = tebiUi, toccabili = new Set([...plan.match.values()].map(m=>m.i).concat(plan.orfani));
  const diff = rows.filter((r,i)=>!toccabili.has(i) && JSON.stringify(r)!==JSON.stringify(out[i])).length;
  const perCat = {}; rows.forEach((r,i)=>{ if(toccabili.has(i)) return; const k=r.REPORTING_CATEGORY||"(senza categoria)"; perCat[k]=(perCat[k]||0)+1; });
  return { diff, perCat, nRighe:out.length };
}

// ─── Caricamento e download ──────────────────────────────────────────────────
function tebiCarica(ev){
  const f = ev.target.files && ev.target.files[0]; if(!f) return;
  if(typeof XLSX==="undefined"){ notify("Libreria Excel non caricata: ricarica la pagina","err"); return; }
  const rd = new FileReader();
  rd.onload = e=>{
    try{
      const wb = XLSX.read(e.target.result, { type:"array" }), ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:true });
      const header = (aoa[0]||[]).map(x=>String(x||"").trim());
      if(!header.includes("NAME") || !header.includes("DISPLAY_SALES_PRICE")){ notify("Non sembra un export prodotti Tebi (mancano NAME / DISPLAY_SALES_PRICE)","err"); return; }
      const rows = aoa.slice(1).filter(r=>r && r.some(v=>v!==null && v!=="")).map(r=>Object.fromEntries(header.map((k,j)=>[k, r[j]===undefined? null : r[j]])));
      rows.forEach(r=>{ if(r.GTIN!=null) r.GTIN = String(r.GTIN); });
      Object.assign(tebiUi, { rows, header, file:f.name, conf:{}, arch:{}, cat:{}, off:{} });
      tebiUi.plan = _tbPiano(rows);
      tebiUi.plan.dubbi.forEach(g=>{ tebiUi.conf[g] = (tebiUi.plan.match.get(g).score>=0.99); });
      tebiUi.plan.cm.forEach(c=>{ const m=tebiUi.plan.match.get(c.gid); if(c.esaurito && m) tebiUi.arch[m.i] = true; });
      render();
    }catch(err){ console.error(err); notify("File non leggibile: "+err.message,"err"); }
  };
  rd.readAsArrayBuffer(f);
}
function tebiReset(){ Object.assign(tebiUi, { rows:null, header:null, file:"", plan:null, conf:{}, arch:{}, cat:{}, off:{} }); render(); }
function tebiSet(k, id, v){ tebiUi[k][id] = v; render(); }
function tebiScarica(){
  const { out } = _tbFondi(), chk = _tbVerifica(out);
  if(chk.diff){ notify(`Controllo fallito: ${chk.diff} righe non di bevande risultano modificate. File non generato.`,"err"); return; }
  const H = tebiUi.header, aoa = [H].concat(out.map(r=>H.map(k=>r[k]===undefined? null : r[k])));
  const ws = XLSX.utils.aoa_to_sheet(aoa), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet0");
  const loc = _tbNorm(typeof CONFIG!=="undefined"&&CONFIG.nomeLocale||"locale").replace(/ /g,"-");
  XLSX.writeFile(wb, `tebi-import-${loc}-${today()}.xlsx`);
  notify("File pronto: importalo in Tebi da Prodotti → Importa (sostituisce tutta la lista)");
}

// ─── UI ──────────────────────────────────────────────────────────────────────
function renderTebiSync(){
  const head = `<div class="pl-h">Cassa Tebi · sincronizzazione prodotti</div>`;
  if(!tebiUi.rows) return `${head}<div class="ex-list">
    <div class="ex-row"><div class="ex-main"><div class="ex-t">Aggiorna l'archivio prodotti della cassa</div>
    <div class="ex-d">1. In Tebi: Prodotti → Elenco prodotti → ⋯ → Esporta elenco prodotti. 2. Carica qui il file. 3. Controlla il riepilogo e scarica il file unito. 4. In Tebi: Prodotti → Importa. Cibo e voci non legate al gestionale restano identici.</div></div>
    <label class="btn-outline btn-sm ex-btn" style="cursor:pointer">${ic("list")} Carica export<input type="file" accept=".xlsx" onchange="tebiCarica(event)" style="display:none"></label></div></div>`;

  const { plan, rows } = tebiUi, { out, log } = _tbFondi(), chk = _tbVerifica(out);
  const byGid = new Map(plan.cm.map(c=>[c.gid,c]));
  const nAbb = [...plan.match.entries()].filter(([g,m])=>m.tipo!=="simile"||tebiUi.conf[g]).length;
  const tab = (rowsHtml, cols) => `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr style="color:var(--txt4);font-size:11px;text-transform:uppercase;letter-spacing:.06em">${cols.map(([l,al])=>`<td style="padding:6px 10px;text-align:${al||"left"}">${l}</td>`).join("")}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
  const tr = cells => `<tr style="border-top:1px solid var(--border)">${cells.map(([v,al,st])=>`<td style="padding:6px 10px;text-align:${al||"left"};${st||""}">${v}</td>`).join("")}</tr>`;
  const blocco = (t, sub, body) => `<div class="ex-list" style="padding:12px 0"><div style="padding:0 18px 8px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b style="font-size:13px">${t}</b><span style="font-size:12px;color:var(--txt4)">${sub||""}</span></div>${body}</div>`;

  let html = `${head}<div class="ex-list"><div class="ex-row"><div class="ex-main"><div class="ex-t">${h(tebiUi.file)}</div>
    <div class="ex-d">${rows.length} righe in cassa · ${plan.cm.length} prodotti dal gestionale · ${nAbb} abbinati · ${log.nuovi.length} nuovi · ${log.prezzi.length} prezzi da aggiornare</div></div>
    <button class="btn-outline btn-sm ex-btn" onclick="tebiReset()">${ic("x")} Annulla</button>
    <button class="btn-primary btn-sm ex-btn" onclick="tebiScarica()" ${chk.diff?"disabled":""}>${ic("download")} Scarica file unito</button></div></div>`;

  const gAll = Object.keys(TB_GRP).filter(g=>plan.cm.some(c=>c.grp===g));
  html += blocco("Cosa mandare in cassa", "togli la spunta per lasciare un gruppo com'è in Tebi",
    tab(gAll.map(g=>{ const cs=plan.cm.filter(c=>c.grp===g), ab=cs.filter(c=>plan.match.has(c.gid)).length;
      return tr([[`<input type="checkbox" ${tebiUi.off[g]?"":"checked"} onchange="tebiSet('off','${g}',!this.checked)">`],[h(TB_GRP[g])],[cs.length,"right"],[ab,"right","color:var(--txt3)"]]); }).join(""),
      [["Invia"],["Gruppo"],["Prodotti","right"],["Già in cassa","right"]]));

  html += blocco("Controllo righe intatte", chk.diff? `<span style="color:var(--red)">${chk.diff} righe alterate: download bloccato</span>` : `<span style="color:var(--green)">${log.invariati} righe identiche all'originale</span>`,
    tab(Object.entries(chk.perCat).sort((a,b)=>b[1]-a[1]).map(([k,n])=>tr([[h(k)],[n,"right"]])).join(""), [["Categoria cassa (non toccate)"],["Righe","right"]]));

  if(plan.dubbi.length) html += blocco("Abbinamenti da confermare", "nomi simili ma non identici: spunta solo se sono lo stesso prodotto",
    tab(plan.dubbi.map(g=>{ const c=byGid.get(g), m=plan.match.get(g), r=rows[m.i];
      return tr([[`<input type="checkbox" ${tebiUi.conf[g]?"checked":""} onchange="tebiSet('conf','${h(g)}',this.checked)">`],[h(c.nome)],[h(r.NAME),"left","color:var(--txt3)"],[fmtN(m.score*100,0)+"%","right","color:var(--txt4)"]]); }).join(""),
      [["Ok"],["Gestionale"],["Cassa Tebi"],["Somiglianza","right"]]));

  if(log.prezzi.length) html += blocco("Prezzi aggiornati", `${log.prezzi.length} prodotti`,
    tab(log.prezzi.map(p=>tr([[h(p.nome)],[p.da? fmt(p.da) : "aperto","right","color:var(--txt3)"],[fmt(p.a),"right"]])).join(""), [["Prodotto"],["Prima","right"],["Dopo","right"]]));

  if(log.nuovi.length){
    const grps = [...new Set(log.nuovi.map(n=>n.grp))];
    const catIn = g => { const t=_tbTemplate(rows,g); return `<input class="form-input" style="width:180px;padding:4px 6px" value="${h(tebiUi.cat[g] ?? TB_CAT_DEF[g] ?? (t&&t.REPORTING_CATEGORY) ?? "")}" onchange="tebiSet('cat','${g}',this.value)">`; };
    html += blocco("Prodotti nuovi in cassa", "reparto, portata, IVA e tag copiati da una voce esistente dello stesso tipo",
      tab(grps.map(g=>tr([[h(TB_GRP[g]||g)],[log.nuovi.filter(n=>n.grp===g).length,"right"],[catIn(g),"right"]])).join(""), [["Gruppo"],["Nuovi","right"],["Categoria report","right"]])
      + `<details style="padding:6px 18px 0"><summary style="font-size:12px;color:var(--txt3);cursor:pointer">Elenco completo</summary>${tab(log.nuovi.slice(0,250).map(n=>tr([[h(n.nome)],[h(TB_GRP[n.grp]||n.grp),"left","color:var(--txt4)"],[fmt(n.prezzo),"right"]])).join(""), [["Prodotto"],["Gruppo"],["Prezzo","right"]])}${log.nuovi.length>250?`<div style="font-size:12px;color:var(--txt4);padding:6px 10px">… e altri ${log.nuovi.length-250}</div>`:""}</details>`);
  }
  if(log.riattivati.length) html += blocco("Riattivati in cassa", "erano archiviati in Tebi, ora sono di nuovo in carta", `<div style="padding:0 18px;font-size:12.5px;color:var(--txt2)">${log.riattivati.map(h).join(" · ")}</div>`);

  const esa = plan.cm.filter(c=>{ const m=plan.match.get(c.gid); return c.esaurito && !tebiUi.off[c.grp] && m && (m.tipo!=="simile"||tebiUi.conf[c.gid]) && rows[m.i].STATUS!=="ARCHIVED"; })
    .map(c=>({ i:plan.match.get(c.gid).i, why:"esaurito nel gestionale", def:true }));
  const fuori = esa.concat(plan.orfani.map(i=>({ i, why:"non più nel gestionale", def:false })));
  if(fuori.length) html += blocco("Non più disponibili", "spunta per archiviarli in cassa (restano recuperabili in Tebi); senza spunta restano come sono",
    tab(fuori.map(x=>{ const on = tebiUi.arch[x.i]!==undefined? tebiUi.arch[x.i]!==false : x.def;
      return tr([[`<input type="checkbox" ${on?"checked":""} onchange="tebiSet('arch',${x.i},this.checked)">`],[h(rows[x.i].NAME)],[x.why,"left","color:var(--txt4)"],[fmt(_tbNum(rows[x.i].DISPLAY_SALES_PRICE)),"right","color:var(--txt3)"]]); }).join(""),
      [["Archivia"],["Prodotto"],["Motivo"],["Prezzo","right"]]));

  html += `<div style="font-size:12px;color:var(--txt4);margin:4px 0 8px">L'import in Tebi sostituisce l'intera lista prodotti: usa sempre un export appena scaricato e importa il file unito subito dopo. Le voci generiche a prezzo aperto (es. "Bottiglia vino", "Calice rosso") restano come sono.</div>`;
  return html;
}

// ═══ VENDITE TEBI → SCARICHI ════════════════════════════════════════════════
// Report "Ordini di prodotti" di Tebi (CSV o XLSX, uno o più giorni insieme) → scarichi nel ledger.
// Abbinamento solo per SKU (lo stesso scritto dalla sincronizzazione prodotti): bottiglie = scarico,
// SKU "-C" = calici (stessa logica del mobile: la bottiglia esce quando si apre). Amari/distillati a dose
// e prodotti bar non sono tracciati qui. Ogni scarico porta m.tebi.key: lo stesso giorno non si importa due volte.
var tebiV = { files:[], righe:null, sel:{} };
const _tvH = s => _tbNorm(s).replace(/ /g,"");
function _tvData(v){
  if(v instanceof Date && !isNaN(v)) return v.toISOString().slice(0,10);
  const s = String(v??"").trim(); let m;
  if((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) return `${m[3].length===2?"20"+m[3]:m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return "";
}
// Legge un foglio (CSV: colonna "Business day"; XLSX: riga-data sopra l'intestazione per ogni gruppo)
function _tvLeggi(aoa){
  const hi = aoa.findIndex(r=>r && r.some(c=>_tvH(c)==="sku") && r.some(c=>_tvH(c)==="quantita"));
  if(hi<0) return null;
  const H = aoa[hi].map(_tvH), col = k => H.indexOf(k);
  const cSku=col("sku"), cQ=col("quantita"), cDay=col("businessday"), cChiu=col("datadichiusura"), cNome=col("nomeproduct"), cInc=col("revenuetotaleinclvat"), cInv=col("idinvoice");
  // XLSX: i totali sono formule ("=SUM(...)") → l'incasso si ricostruisce da imponibile + imposta
  const cParti = H.map((k,j)=>/^(importonetiva|importodellimpostaiva)\d+$/.test(k)? j : -1).filter(j=>j>=0);
  const num = v => typeof v==="number"? v : ((v==null || v==="" || /^=/.test(String(v)))? NaN : _tbNum(v));
  const out = []; let gruppo = "";
  for(let i=hi+1;i<aoa.length;i++){
    const r = aoa[i]; if(!r) continue;
    const c0 = String(r[0]??"").trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(c0) && r.slice(1).every(v=>v==null||v==="")){ gruppo = c0; continue; } // XLSX: inizio gruppo giorno
    if(r.map(_tvH).includes("sku")) continue;                                                           // intestazione ripetuta
    if(/^(grand )?total$/i.test(c0)) continue;
    const sku = String(r[cSku]??"").trim(), q = _tbNum(r[cQ]);
    if(!sku || !q) continue;
    const day = (cDay>=0 && _tvData(r[cDay])) || gruppo || _tvData(r[cChiu]);
    if(!day) continue;
    out.push({ sku, q, day, nome:String(r[cNome]??""), incasso:(cInc>=0 && isFinite(num(r[cInc])))? num(r[cInc]) : cParti.reduce((t,j)=>t+(isFinite(num(r[j]))? num(r[j]) : 0),0), inv:cInv>=0? String(r[cInv]??"") : "" });
  }
  return out;
}
function _tvIndice(){
  const ix = new Map();
  wines.forEach(w=>{
    [w.sku, "W-"+_tbHash(w.id)].filter(Boolean).forEach(s=>{
      if(!ix.has(s)) ix.set(s, { w, cal:false });
      if(!ix.has(s+"-C")) ix.set(s+"-C", { w, cal:true });
    });
  });
  return ix;
}
// Piano: righe aggregate per giorno+vino+tipo, con esito simulato in ordine cronologico
function _tvPiano(){
  const ix = _tvIndice(), agg = new Map(), extra = { bar:0, dose:new Map(), ignoti:new Map() };
  (tebiV.righe||[]).forEach(r=>{
    if(/^BAR-/.test(r.sku)){ extra.bar += r.q; return; }
    const hit = ix.get(r.sku);
    if(!hit){ const k=r.sku+" · "+r.nome; extra.ignoti.set(k,(extra.ignoti.get(k)||0)+r.q); return; }
    if(!hit.cal && _tbSoloDose(hit.w)){ extra.dose.set(hit.w.nome,(extra.dose.get(hit.w.nome)||0)+r.q); return; }
    const key = `${r.day}|${hit.w.id}|${hit.cal?"C":"B"}`;
    const a = agg.get(key) || { key, day:r.day, w:hit.w, cal:hit.cal, q:0, incasso:0, nome:r.nome };
    a.q += r.q; a.incasso += r.incasso; agg.set(key, a);
  });
  const fatti = new Set(movements.filter(m=>m.tebi && m.tebi.key).map(m=>m.tebi.key));
  const manuali = new Set(movements.filter(m=>m.tipo==="scarico" && !m.tebi).map(m=>`${m.data}|${m.wineId}`));
  const stato = new Map(); // simulazione giacenza e calici aperti per vino
  const righe = [...agg.values()].filter(a=>a.q>0).sort((a,b)=>a.day.localeCompare(b.day) || String(a.w.nome).localeCompare(String(b.w.nome)));
  righe.forEach(a=>{
    const w = wines.find(x=>x.id===a.w.id) || a.w; a.w = w;
    if(!stato.has(w.id)) stato.set(w.id, { g:parseInt(w.giacenza)||0, ap:parseInt(w.caliciAperta)||0 });
    const st = stato.get(w.id);
    if(fatti.has(a.key)){ a.esito="fatto"; return; }
    if(typeof _periodoChiuso==="function" && _periodoChiuso(a.day)){ a.esito="chiuso"; return; }
    if(a.cal){ a.piano = _caliciPiano({ ...w, caliciAperta:st.ap }, a.q); a.bt = a.piano.bt; } else a.bt = a.q;
    if(a.bt > st.g){ a.esito="giacenza"; a.giac=st.g; return; }
    a.esito = manuali.has(`${a.day}|${w.id}`)? "manuale" : "ok";
    if(tebiV.sel[a.key]===undefined) tebiV.sel[a.key] = a.esito==="ok";
    if(tebiV.sel[a.key]){ st.g -= a.bt; if(a.cal) st.ap = a.piano.dopo; }
  });
  return { righe, extra };
}
function tebiVCarica(ev){
  const fs = [...(ev.target.files||[])]; if(!fs.length) return;
  if(typeof XLSX==="undefined"){ notify("Libreria Excel non caricata: ricarica la pagina","err"); return; }
  Promise.all(fs.map(f=>new Promise((ok,ko)=>{
    const rd = new FileReader(), csv = /\.csv$/i.test(f.name);
    rd.onload = e=>{ try{
      const wb = csv? XLSX.read(e.target.result, { type:"string", raw:true }) : XLSX.read(e.target.result, { type:"array", cellDates:true });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, defval:null, raw:true });
      const r = _tvLeggi(aoa); if(!r) throw new Error(`${f.name}: non è un report "Ordini di prodotti" di Tebi (mancano SKU/Quantità)`);
      ok({ nome:f.name, righe:r });
    }catch(err){ ko(err); } };
    rd.onerror = ()=>ko(new Error(f.name+": lettura fallita"));
    csv? rd.readAsText(f, "utf-8") : rd.readAsArrayBuffer(f);
  }))).then(res=>{
    // stesso giorno in due file (es. CSV + XLSX dello stesso report): si tiene il primo, niente doppioni
    const giorni = new Set(), righe = [];
    res.forEach(x=>{ const gg = new Set(x.righe.map(r=>r.day)); const nuovi = x.righe.filter(r=>!giorni.has(r.day)); [...gg].forEach(d=>giorni.add(d)); righe.push(...nuovi); });
    Object.assign(tebiV, { files:res.map(x=>x.nome), righe, sel:{} });
    ev.target.value = ""; render();
  }).catch(err=>{ console.error(err); notify(err.message,"err"); ev.target.value = ""; });
}
function tebiVReset(){ Object.assign(tebiV, { files:[], righe:null, sel:{} }); render(); }
function tebiVSet(k, v){ tebiV.sel[k] = v; render(); }
function tebiVRegistra(){
  if(typeof _syncGate==="function" && !_syncGate("Scarico vendite Tebi")) return;
  const { righe } = _tvPiano(), da = righe.filter(a=>tebiV.sel[a.key] && (a.esito==="ok"||a.esito==="manuale"));
  if(!da.length){ notify("Nessuna riga selezionata","err"); return; }
  const ts = Date.now(), nuovi = [], fonte = tebiV.files.join(", ");
  da.forEach(a=>{
    const w = wines.find(x=>x.id===a.w.id); if(!w) return;
    const base = { id:uid(), wineId:w.id, wineName:w.nome, produttore:w.produttore, nazione:w.nazione||"", tipo:"scarico",
      data:a.day, fattura:`TEBI-${a.day}`, fornitore:"", costoUnitarioIva:calcCostoIvaBottiglia(w), prezzoCartaSnap:parseFloat(w.prezzoCarta)||0, ts,
      tebi:{ key:a.key, q:a.q, incasso:_tbR2(a.incasso), file:fonte } };
    if(a.cal){
      const p = _caliciPiano(w, a.q);
      if(p.bt > (parseInt(w.giacenza)||0)) return;
      const m = { ...base, qty:p.bt, calici:a.q, caliciBt:p.cpb, caliciPrima:p.prima, caliciDopo:p.dopo, servizio:0,
        prezzoCaliceSnap:(parseFloat(w.prezzoCalice)||0) || _tbR2(a.incasso/a.q), note:`[Tebi] ${a.q} calic${a.q>1?"i":"e"}${p.bt?` · aperta ${p.bt} bt`:""}` };
      let rem = p.bt;
      const lots = (w.lots||[]).map(l=>{ if(rem<=0||l.qtyRimanente<=0) return l; const c=Math.min(rem,l.qtyRimanente); rem-=c; return {...l, qtyRimanente:l.qtyRimanente-c}; });
      _fifoShort(w.id, w.nome, rem);
      wines = wines.map(x=>x.id===w.id? {...x, giacenza:(parseInt(x.giacenza)||0)-p.bt, lots, caliciAperta:p.dopo} : x);
      nuovi.push(m);
    } else {
      if(a.q > (parseInt(w.giacenza)||0)) return;
      const m = { ...base, qty:a.q, servizio:_servizioSnap(a.day), note:"[Tebi] vendita in cassa" };
      const disp = (w.lots||[]).reduce((s,l)=>s+Math.max(0,parseInt(l.qtyRimanente)||0),0);
      _fifoShort(w.id, w.nome, Math.max(0,a.q-disp));
      wines = wines.map(x=>x.id===w.id? _applyMovEffect(x,m) : x);
      nuovi.push(m);
    }
  });
  if(!nuovi.length){ notify("Nessuno scarico registrato: giacenze insufficienti","err"); return; }
  movements = [...nuovi, ...movements];
  scheduleSave(); clearTimeout(saveTimer); _flushSave();
  const bt = nuovi.reduce((s,m)=>s+m.qty,0), cal = nuovi.reduce((s,m)=>s+(parseInt(m.calici)||0),0);
  notify(`Vendite Tebi registrate: ${nuovi.length} scarichi · ${bt} bottigli${bt===1?"a":"e"}${cal?` · ${cal} calici`:""}`);
  tebiV.sel = {}; render();
}
function renderTebiVendite(){
  const head = `<div class="pl-h">Cassa Tebi · vendite → scarichi</div>`;
  if(!tebiV.righe) return `${head}<div class="ex-list"><div class="ex-row"><div class="ex-main"><div class="ex-t">Scarica le bottiglie vendute in cassa</div>
    <div class="ex-d">In Tebi: Insights → Elenco report → Report ordini di prodotti → un giorno → Esporta (CSV o Excel). Puoi caricare più giorni insieme. Abbinamento per SKU; i giorni già importati vengono saltati.</div></div>
    <label class="btn-outline btn-sm ex-btn" style="cursor:pointer">${ic("list")} Carica report<input type="file" accept=".csv,.xlsx" multiple onchange="tebiVCarica(event)" style="display:none"></label></div></div>`;
  const { righe, extra } = _tvPiano();
  const ES = { ok:["","da registrare"], manuale:["var(--amber,#c90)","già scaricato a mano quel giorno"], fatto:["var(--txt4)","già importato"], chiuso:["var(--txt4)","periodo chiuso"], giacenza:["var(--red)","giacenza insufficiente"] };
  const sel = righe.filter(a=>tebiV.sel[a.key] && (a.esito==="ok"||a.esito==="manuale"));
  const giorni = [...new Set((tebiV.righe||[]).map(r=>r.day))].sort();
  const tr = cells => `<tr style="border-top:1px solid var(--border)">${cells.map(([v,al,st])=>`<td style="padding:6px 10px;text-align:${al||"left"};${st||""}">${v}</td>`).join("")}</tr>`;
  let html = `${head}<div class="ex-list"><div class="ex-row"><div class="ex-main"><div class="ex-t">${h(tebiV.files.join(" · "))}</div>
    <div class="ex-d">${giorni.length} giorn${giorni.length===1?"o":"i"} (${giorni.map(d=>_fmtDataIT? _fmtDataIT(d) : d).join(", ")}) · ${righe.length} righe vino · ${sel.length} selezionate · ${sel.reduce((s,a)=>s+a.bt,0)} bottiglie in uscita</div></div>
    <button class="btn-outline btn-sm ex-btn" onclick="tebiVReset()">${ic("x")} Annulla</button>
    <button class="btn-primary btn-sm ex-btn" onclick="tebiVRegistra()" ${sel.length?"":"disabled"}>${ic("download")} Registra scarichi</button></div></div>`;
  if(righe.length) html += `<div class="ex-list" style="padding:8px 0"><table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr style="color:var(--txt4);font-size:11px;text-transform:uppercase;letter-spacing:.06em"><td style="padding:6px 10px"></td><td style="padding:6px 10px">Giorno</td><td style="padding:6px 10px">Vino</td><td style="padding:6px 10px;text-align:right">Venduto</td><td style="padding:6px 10px;text-align:right">Bt in uscita</td><td style="padding:6px 10px;text-align:right">Giac.</td><td style="padding:6px 10px">Stato</td></tr></thead><tbody>${
    righe.map(a=>{ const [col,txt] = ES[a.esito], on = !!tebiV.sel[a.key], can = a.esito==="ok"||a.esito==="manuale";
      return tr([[can? `<input type="checkbox" ${on?"checked":""} onchange="tebiVSet('${h(a.key)}',this.checked)">` : ""],
        [_fmtDataIT? _fmtDataIT(a.day) : a.day,"left","white-space:nowrap"],
        [`${h(a.w.nome)} <span style="color:var(--txt4)">${h(a.w.produttore||"")}${a.w.annata?" "+h(a.w.annata):""}</span>`],
        [a.cal? `${a.q} calic${a.q>1?"i":"e"}` : `${a.q} bt`,"right"], [a.bt!=null? a.bt : "–","right"],
        [parseInt(a.w.giacenza)||0,"right","color:var(--txt3)"], [txt + (a.esito==="giacenza"? ` (${a.giac})` : ""),"left",`color:${col||"var(--txt2)"}`]]); }).join("")
  }</tbody></table></div>`;
  const note = [];
  if(extra.dose.size) note.push(`Non tracciati (a dose): ${[...extra.dose].map(([n,q])=>`${h(n)} ×${q}`).join(", ")}`);
  if(extra.bar) note.push(`Prodotti bar: ${extra.bar} pezzi, gestiti nella sezione Bar`);
  if(extra.ignoti.size) note.push(`<span style="color:var(--red)">SKU non trovati nel gestionale</span>: ${[...extra.ignoti].map(([n,q])=>`${h(n)} ×${q}`).join(", ")}`);
  if(note.length) html += `<div style="font-size:12px;color:var(--txt3);margin:4px 0 8px;line-height:1.6">${note.join("<br>")}</div>`;
  html += `<div style="font-size:12px;color:var(--txt4);margin:4px 0 8px">Le voci senza SKU (es. "Bottiglia vino" a prezzo aperto) non si possono abbinare e vanno scaricate a mano. Data dello scarico = giornata di servizio di Tebi.</div>`;
  return html;
}

// Aggancio alla pagina Export senza modificare manager.js
(function(){
  if(typeof renderExport!=="function") return;
  const _orig = renderExport;
  renderExport = function(){
    const base = _orig.apply(this, arguments), sync = renderTebiVendite() + renderTebiSync(), cut = base.lastIndexOf("</div>");
    return cut<0? base+sync : base.slice(0,cut)+sync+base.slice(cut);
  };
})();
