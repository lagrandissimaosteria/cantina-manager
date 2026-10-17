/* tebi.js — Sincronizzazione cassa Tebi (sezione in Export & Bilancio).
Flusso: export prodotti da Tebi (.xlsx) → caricato qui → fusione con vini in carta + prodotti Bar →
riepilogo e conferma abbinamenti dubbi → scarica il file completo da reimportare in Tebi (Prodotti → Importa).
Regole: le righe Tebi non abbinate (cibo, coperto, voci generiche) escono IDENTICHE, colonna per colonna;
le righe abbinate cambiano solo prezzo, costo netto, SKU e (se archiviate) stato. Nessun dato del gestionale viene modificato.
Dipende da manager.js (wines, CONFIG, h, fmt, fmtN, ic, notify, render, today, XLSX) e, se presente, bar.js (_barProdotti, ORD_CAT). */
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
      const cat = (tebiUi.cat[c.grp]||"").trim(); if(cat) r.REPORTING_CATEGORY = cat;
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
    const catIn = g => { const t=_tbTemplate(rows,g); return `<input class="form-input" style="width:180px;padding:4px 6px" value="${h(tebiUi.cat[g] ?? (t&&t.REPORTING_CATEGORY) ?? "")}" onchange="tebiSet('cat','${g}',this.value)">`; };
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

// Aggancio alla pagina Export senza modificare manager.js
(function(){
  if(typeof renderExport!=="function") return;
  const _orig = renderExport;
  renderExport = function(){
    const base = _orig.apply(this, arguments), sync = renderTebiSync(), cut = base.lastIndexOf("</div>");
    return cut<0? base+sync : base.slice(0,cut)+sync+base.slice(cut);
  };
})();
