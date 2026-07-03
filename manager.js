// ─── CONSTANTS ───────────────────────────────────────────────────────────────
// Password stored as SHA-256 hash. Default: "cantina2024"
// Per cambiare password: in console > sha256("nuova") e aggiorna PASSWORD_HASH
// M5 NOTE: SHA-256 senza salt è sufficiente per una singola installazione privata
// locale/Supabase. Per deployment multi-utente o pubblico, sostituire con
// Argon2/bcrypt via backend (Supabase Edge Function) e non esporre il hash nel JS.
const PASSWORD_HASH = "4308b16b088ef46766393f253ec3d48d96dfc04e80712cc0c55f0491c848fbad";

// S9: nome locale centralizzato — usato in stampaOrdine, emailOrdine e stampa PDF
const NOME_LOCALE = "Osteria Lagrandissima";

// Array di default definito una sola volta — riusato in init, reset e catch
const TIPOLOGIE_DEFAULT = ["Rosso","Bianco","Rosato","Champagne","Metodo Classico","Metodo Classico Rosato","Rifermentato","Rifermentato Rosso","Rifermentato Rosato","Col Fondo","Ancestrale","Macerato","Orange","Passito","Dolce","Liquoroso"];
let TIPOLOGIE = (()=>{ try{ const s=localStorage.getItem("cm_tipologie"); return s?JSON.parse(s):[...TIPOLOGIE_DEFAULT]; }catch{ return [...TIPOLOGIE_DEFAULT]; } })();
function _saveTipologie(){try{localStorage.setItem("cm_tipologie",JSON.stringify(TIPOLOGIE));}catch{}}
function _tipoOptsHtml(selected){
  return TIPOLOGIE.map(t=>`<option value="${h(t)}"${t===selected?" selected":""}>${h(t)}</option>`).join("")
    + `<option value="__new__">+ Nuova tipologia…</option>`;
}
function _addTipologiaInline(sel, onNewTipo){
  if(sel.value !== "__new__") return;
  const nuova = (prompt("Nome nuova tipologia:") || "").trim();
  if(!nuova){ sel.value = sel.dataset.prev || TIPOLOGIE[0]; return; }
  if(!TIPOLOGIE.includes(nuova)){ TIPOLOGIE.push(nuova); _saveTipologie(); }
  const newOpt = document.createElement("option");
  newOpt.value = nuova; newOpt.textContent = nuova;
  sel.insertBefore(newOpt, sel.querySelector('option[value="__new__"]'));
  sel.value = nuova;
  sel.dataset.prev = nuova;
  if(onNewTipo) onNewTipo(nuova);
}
const IVA_OPTIONS = [4,10,22];
const FALLATA_MOTIVI = ["Tappo difettoso (TCA)","Bottiglia rotta","Ossidazione","Rifermentazione anomala","Vino ridotto","Deterioramento","Degustazione didattica","Altro difetto"];
const PIE_COLORS = ["#FF9F0A","#007AFF","#30D158","#BF5AF2","#FF375F","#32ADE6","#FF6B0A","#34C759","#FF9500"];

// ─── STATE ────────────────────────────────────────────────────────────────────
let wines = [], movements = [], fallate = [], alertSoglie = {}, orders = [];
let _bozzeSb = []; // bozze da ordini_testata+righe, caricate in background
let section = "dashboard";
let search = "", filterTipo = "tutti", filterFormato = "tutti",
    filterDistrib = "tutti", filterProduttore = "tutti", filterRegione = "tutti", filterNazione = "tutti",
    filterGiacenza = "tutti", // "tutti"|"esaurito"|"basso"|"ok"
    invSort = "tipologia", invSortDir = 1; // 1=asc, -1=desc
let filterVitigni = new Set(); // multi-select vitigni (chiavi lowercase); Set vuoto = tutti
let analyticsRegione = "", analyticsTipo = "", analyticsAcquistiPeriodo = "mese";
let movForm = {wineId:"",tipo:"carico",qty:1,data:today(),fattura:"",fornitore:"",note:"",prezzoAcqLotto:"",_wineText:"",_newProduttore:"",_newTipologia:"Rosso",_newPrezzoCarta:"",_newVitigni:"",_newZona:"",_newAnnata:"",_newRegione:"",_newNazione:"Italia",_newIva:22,_newDistributore:"",_tipologia:"",_newMode:false};
let fallForm = {wineId:"",qty:1,motivo:"Tappo difettoso (TCA)",data:today(),note:""};
// ─── PRICE SUGGESTION (FASCE PREZZO CARTA) ───────────────────────────────────
// Fascia su prezzoAcq (ex IVA):
//   < €12        → ×3.0
//   €12–18       → ×2.85
//   €18–25       → ×2.5
//   > €25        → ×2.3
// Magnum (rilevata da nome/formato) → ×2.0
// Risultato arrotondato al mezzo euro superiore, IVA inclusa.
function _getMolt(w){
  const fmt = parseFloat(w.formato)||0.75;
  if(fmt > 0.75) return 2.0; // tutti i grandi formati → ×2.0
  const p = parseFloat(w.prezzoAcq)||0;
  if(p < 12)  return 3.0;
  if(p < 18)  return 2.85;
  if(p < 25)  return 2.5;
  return 2.3;
}
function _calcPrezzoCartaSuggerito(w){
  const p = parseFloat(w.prezzoAcq)||0;
  if(!p) return null;
  const iva = (parseInt(w.iva)||22)/100;
  const costoIva = p * (1 + iva);
  const molt = _getMolt(w);
  return Math.ceil(costoIva * molt); // arrotonda all'euro superiore
}
function _getMoltLabel(w){
  const fmt = parseFloat(w.formato)||0.75;
  if(fmt > 0.75) return `×2.0 (${fmt}L)`;
  const p = parseFloat(w.prezzoAcq)||0;
  if(p < 12)  return "×3.0 (< €12)";
  if(p < 18)  return "×2.85 (€12–18)";
  if(p < 25)  return "×2.5 (€18–25)";
  return "×2.3 (> €25)";
}

let modalWine = null;
let notifTimer = null;

// ─── MULTI-SELECT STATE ───────────────────────────────────────────────────────
let _mobQuery = "";
let _mobLog = []; // [{ts, desc}]
let _mobUndoData = null; // {wineId, delta, movId, prevGiacenza, prevLots}
let _mobToastTimer = null;
let _mobToastBarTimer = null;
let _mobAccordionOpen = {}; // { tipologia: true/false }
let _mobSteppers = {};      // { wineId: qty }
let selMode = null; // 'wines' | 'movimenti' | 'ordini'
let selIds  = new Set();
let _selAllIds = []; // IDs di tutte le righe visibili, aggiornato dal render
function enterSel(mode){ selMode=mode; selIds=new Set(); render(); }
function exitSel(){ selMode=null; selIds=new Set(); const bm=document.getElementById('inv-bulk-menu'); if(bm) bm.style.display='none'; render(); }
function toggleSel(id){ if(selIds.has(id)) selIds.delete(id); else selIds.add(id); _updateBulkBar(); }
function toggleSelAll(ids){ const list=ids&&ids.length?ids:_selAllIds; const all=list.length>0&&list.every(id=>selIds.has(id)); list.forEach(id=>all?selIds.delete(id):selIds.add(id)); _updateBulkBar(); }
function _updateBulkBar(){
  const bar=document.getElementById("bulk-bar");
  if(!bar) return;
  const n=selIds.size;
  // counter
  const countEl=document.getElementById("bulk-count");
  if(countEl) countEl.textContent=`${n} selezionat${n===1?"o":"i"}`;
  // abilita/disabilita bottoni action
  ["bulk-btn-delete","bulk-btn-edit","bulk-btn-ordine"].forEach(id=>{
    const btn=document.getElementById(id);
    if(!btn) return;
    btn.disabled=(n===0);
    btn.classList.toggle("bulk-btn-disabled",n===0);
  });
  // aggiorna checkbox singole
  document.querySelectorAll(".cb-sel[data-id]").forEach(cb=>{ cb.checked=selIds.has(cb.dataset.id); });
  // aggiorna checkbox "seleziona tutto"
  const allCb=document.getElementById("cb-sel-all");
  if(allCb){
    const visibleIds=[...document.querySelectorAll(".cb-sel[data-id]")].map(c=>c.dataset.id);
    allCb.checked=visibleIds.length>0&&visibleIds.every(id=>selIds.has(id));
    allCb.indeterminate=n>0&&!allCb.checked;
  }
  // evidenzia righe selezionate
  document.querySelectorAll("tr[data-sel-id]").forEach(tr=>{ tr.classList.toggle("row-selected",selIds.has(tr.dataset.selId)); });
}

let activeCharts = {};

// ─── UTILS ───────────────────────────────────────────────────────────────────
function uid(){return (typeof crypto!=="undefined"&&crypto.randomUUID)?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)}
const _eur = new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"});
const _num0 = new Intl.NumberFormat("it-IT",{minimumFractionDigits:0,maximumFractionDigits:0});
const _num1 = new Intl.NumberFormat("it-IT",{minimumFractionDigits:1,maximumFractionDigits:1});
const _num2 = new Intl.NumberFormat("it-IT",{minimumFractionDigits:2,maximumFractionDigits:2});
// ── INFERISCE IL PAESE DALLA REGIONE ─────────────────────────────────────────
const _REGIONE_TO_PAESE = {
  // ── ITALIA ──
  "abruzzo":"Italia","alto adige":"Italia","südtirol":"Italia","basilicata":"Italia",
  "calabria":"Italia","campania":"Italia","emilia romagna":"Italia","emilia-romagna":"Italia",
  "friuli venezia giulia":"Italia","friuli-venezia giulia":"Italia","friuli":"Italia",
  "lazio":"Italia","liguria":"Italia","lombardia":"Italia","marche":"Italia","molise":"Italia",
  "piemonte":"Italia","puglia":"Italia","sardegna":"Italia","sicilia":"Italia",
  "toscana":"Italia","trentino alto adige":"Italia","trentino-alto adige":"Italia",
  "trentino":"Italia","umbria":"Italia","valle d'aosta":"Italia","valle daosta":"Italia",
  "veneto":"Italia","romagna":"Italia","collio":"Italia","collio goriziano":"Italia",
  "colli orientali":"Italia","carso":"Italia","isonzo":"Italia","soave":"Italia",
  "valpolicella":"Italia","bardolino":"Italia","lugana":"Italia","garda":"Italia",
  "franciacorta":"Italia","oltrepò pavese":"Italia","langhe":"Italia","barolo":"Italia",
  "barbaresco":"Italia","monferrato":"Italia","asti":"Italia","alba":"Italia",
  "chianti":"Italia","brunello":"Italia","montalcino":"Italia","montepulciano":"Italia",
  "maremma":"Italia","bolgheri":"Italia","etna":"Italia","pantelleria":"Italia",
  "irpinia":"Italia","sannio":"Italia","cilento":"Italia","salento":"Italia",
  "primitivo":"Italia","negroamaro":"Italia","castel del monte":"Italia",
  "cirò":"Italia","ciro":"Italia","terre di cosenza":"Italia",
  "morellino":"Italia","scansano":"Italia","vermentino":"Italia",
  "vernaccia":"Italia","orvieto":"Italia","sagrantino":"Italia","montefalco":"Italia",
  "colli amerini":"Italia","colli di luni":"Italia","cinque terre":"Italia",
  "valdichiana":"Italia","colli euganei":"Italia","berici":"Italia",
  "conegliano valdobbiadene":"Italia","prosecco":"Italia","treviso":"Italia",
  // ── FRANCIA ──
  "alsazia":"Francia","alsace":"Francia","ardeche":"Francia","ardèche":"Francia",
  "auvergne":"Francia","beaujolais":"Francia","bordeaux":"Francia","gironde":"Francia",
  "borgogna":"Francia","bourgogne":"Francia","burgundy":"Francia","chablis":"Francia",
  "champagne":"Francia","cotes catalanes":"Francia","côtes catalanes":"Francia",
  "jura":"Francia","languedoc":"Francia","languedoc-roussillon":"Francia",
  "languedoc – roussillon":"Francia","roussillon":"Francia",
  "loira":"Francia","loire":"Francia","touraine":"Francia","anjou":"Francia",
  "sancerre":"Francia","pouilly":"Francia","muscadet":"Francia",
  "nuova aquitania – charente":"Francia","nuova aquitania – dordogna":"Francia",
  "bergerac":"Francia","cahors":"Francia","gascogne":"Francia","armagnac":"Francia",
  "provenza":"Francia","provence":"Francia","bandol":"Francia","cassis":"Francia",
  "rodano":"Francia","rhône":"Francia","rhone":"Francia","chateauneuf":"Francia",
  "chateauneuf-du-pape":"Francia","gigondas":"Francia","vacqueyras":"Francia",
  "crozes-hermitage":"Francia","hermitage":"Francia","côte-rôtie":"Francia",
  "savoia":"Francia","savoie":"Francia","sud ouest":"Francia","sud-ouest":"Francia",
  "corse":"Francia","corsica":"Francia","ile de beauté":"Francia",
  "saint-emilion":"Francia","pomerol":"Francia","medoc":"Francia","médoc":"Francia",
  "pauillac":"Francia","margaux":"Francia","graves":"Francia","sauternes":"Francia",
  "nuits-saint-georges":"Francia","gevrey":"Francia","meursault":"Francia",
  "puligny":"Francia","chassagne":"Francia","macon":"Francia","mâcon":"Francia",
  "cote de nuits":"Francia","côte de nuits":"Francia","cote de beaune":"Francia",
  "côte de beaune":"Francia","morgon":"Francia","fleurie":"Francia","moulin-a-vent":"Francia",
  // ── GERMANIA ──
  "baden":"Germania","franconia":"Germania","franken":"Germania",
  "mosella":"Germania","mosel":"Germania","mosel-saar-ruwer":"Germania",
  "pfalz":"Germania","rheingau":"Germania","rheinhessen":"Germania",
  "nahe":"Germania","ahr":"Germania","württemberg":"Germania","mittelrhein":"Germania",
  "sachsen":"Germania","saale-unstrut":"Germania","hessische bergstrasse":"Germania",
  // ── AUSTRIA ──
  "burgenland":"Austria","niederösterreich":"Austria","steiermark":"Austria",
  "wagram":"Austria","wachau":"Austria","kamptal":"Austria","kremstal":"Austria",
  "wien":"Austria","vienna":"Austria","thermenregion":"Austria","carnuntum":"Austria",
  "neusiedlersee":"Austria","leithaberg":"Austria","mittelburgenland":"Austria",
  "südsteiermark":"Austria","weststeiermark":"Austria","vulkanland":"Austria",
  // ── SPAGNA ──
  "andalusia":"Spagna","andalucía":"Spagna","bierzo":"Spagna",
  "castilla y leon":"Spagna","castilla-y-leon":"Spagna","castilla la mancha":"Spagna",
  "catalogna":"Spagna","cataluña":"Spagna","penedès":"Spagna","penedes":"Spagna",
  "gran canaria":"Spagna","lanzarote":"Spagna","tenerife":"Spagna","isole canarie":"Spagna",
  "manchuela":"Spagna","la mancha":"Spagna","paesi baschi":"Spagna","país vasco":"Spagna",
  "priorat":"Spagna","priorato":"Spagna","montsant":"Spagna","tarragona":"Spagna",
  "rias baixas":"Spagna","rías baixas":"Spagna","ribeira sacra":"Spagna",
  "ribera del duero":"Spagna","rioja":"Spagna","rioja alavesa":"Spagna",
  "navarra":"Spagna","jerez":"Spagna","sherry":"Spagna","madrid":"Spagna",
  "andia":"Spagna","villanueva de avila":"Spagna","somontano":"Spagna",
  "jumilla":"Spagna","yecla":"Spagna","bullas":"Spagna","alicante":"Spagna",
  "valencia":"Spagna","utiel-requena":"Spagna","galicia":"Spagna",
  "cava":"Spagna","terra alta":"Spagna","empordà":"Spagna",
  // ── PORTOGALLO ──
  "alentejo":"Portogallo","bairrada":"Portogallo","douro":"Portogallo",
  "minho":"Portogallo","serra da estrela":"Portogallo","vinho verde":"Portogallo",
  "dao":"Portogallo","dão":"Portogallo","tejo":"Portogallo","ribatejo":"Portogallo",
  "lisboa":"Portogallo","setubal":"Portogallo","setúbal":"Portogallo",
  "algarve":"Portogallo","madeira":"Portogallo","azores":"Portogallo","açores":"Portogallo",
  "porto":"Portogallo","port":"Portogallo","moscatel":"Portogallo",
  "palmela":"Portogallo","arruda":"Portogallo","estremadura":"Portogallo",
  // ── SLOVENIA ──
  "collio sloveno":"Slovenia","brda":"Slovenia","vipava":"Slovenia",
  "kras":"Slovenia","kras-karst":"Slovenia","primorska":"Slovenia",
  "podravje":"Slovenia","posavje":"Slovenia",
  // ── GRECIA ──
  "santorini":"Grecia","naoussa":"Grecia","nemea":"Grecia","macedonia":"Grecia",
  "makedonia":"Grecia","creta":"Grecia","crete":"Grecia","peloponneso":"Grecia",
  "aegean":"Grecia","kefalonia":"Grecia","patrasso":"Grecia","mantinia":"Grecia",
  "rapsani":"Grecia","goumenissa":"Grecia","amyndeon":"Grecia",
  // ── ALTRI EUROPA ──
  "rila":"Bulgaria","trakia":"Bulgaria","danube plain":"Bulgaria",
  "serbia":"Serbia","sumadija":"Serbia","fruska gora":"Serbia",
  "moldova":"Moldavia","dealu mare":"Romania","transylvania":"Romania",
  "cotnari":"Romania","murfatlar":"Romania","oltenia":"Romania",
  "tokaj":"Ungheria","eger":"Ungheria","villany":"Ungheria","szekszard":"Ungheria",
  "bikavér":"Ungheria","badacsony":"Ungheria",
  "moravia":"Repubblica Ceca","bohemia":"Repubblica Ceca",
  "istria":"Croazia","dalmazia":"Croazia","slavonia":"Croazia",
  "kosovo":"Kosovo","makedonia":"Macedonia del Nord",
  // ── SVIZZERA ──
  "aargau":"Svizzera","valais":"Svizzera","ticino":"Svizzera",
  "vaud":"Svizzera","ginevra":"Svizzera","genève":"Svizzera",
  "graubünden":"Svizzera","schaffhausen":"Svizzera","zurich":"Svizzera",
  "neuchâtel":"Svizzera","fribourg":"Svizzera","bern":"Svizzera","thurgau":"Svizzera",
  // ── MEDIO ORIENTE ──
  "valle della beeka":"Libano","bekaa":"Libano","batroun":"Libano","byblos":"Libano",
  "galilea":"Israele","golan":"Israele","carmel":"Israele","judean hills":"Israele",
  "cappadocia":"Turchia","thrace":"Turchia","aegean turkey":"Turchia",
  // ── AMERICHE ──
  "maipo valley":"Cile","colchagua":"Cile","casablanca":"Cile","aconcagua":"Cile",
  "maule":"Cile","bio bio":"Cile","itata":"Cile","limari":"Cile","elqui":"Cile",
  "mendoza":"Argentina","san juan":"Argentina","la rioja argentina":"Argentina",
  "salta":"Argentina","patagonia":"Argentina","rio negro":"Argentina",
  "sonoma":"Stati Uniti","napa":"Stati Uniti","napa valley":"Stati Uniti",
  "willamette valley":"Stati Uniti","columbia valley":"Stati Uniti",
  "finger lakes":"Stati Uniti","paso robles":"Stati Uniti","santa barbara":"Stati Uniti",
  "lodi":"Stati Uniti","anderson valley":"Stati Uniti","russian river":"Stati Uniti",
  "texas":"Stati Uniti","virginia":"Stati Uniti","new york":"Stati Uniti",
  "okanagan":"Canada","niagara":"Canada","prince edward county":"Canada",
  // ── OCEANIA ──
  "margaret river":"Australia","victoria":"Australia","barossa":"Australia",
  "barossa valley":"Australia","hunter valley":"Australia","mclaren vale":"Australia",
  "coonawarra":"Australia","yarra valley":"Australia","clare valley":"Australia",
  "eden valley":"Australia","rutherglen":"Australia","mornington":"Australia",
  "central otago":"Nuova Zelanda","marlborough":"Nuova Zelanda","nelson":"Nuova Zelanda",
  "hawke's bay":"Nuova Zelanda","wairarapa":"Nuova Zelanda","gisborne":"Nuova Zelanda",
  // ── AFRICA ──
  "western cape":"Sudafrica","stellenbosch":"Sudafrica","paarl":"Sudafrica",
  "franschhoek":"Sudafrica","swartland":"Sudafrica","walker bay":"Sudafrica",
  "elgin":"Sudafrica","constantia":"Sudafrica","robertson":"Sudafrica",
  // ── GEORGIA / ARMENIA ──
  "kakheti":"Georgia","kartli":"Georgia","imereti":"Georgia","racha":"Georgia",
  "ararat valley":"Armenia","vayots dzor":"Armenia",
  // ── GIAPPONE ──
  "yamanashi":"Giappone","nagano":"Giappone","hokkaido":"Giappone","yamagata":"Giappone",
};
function inferPaese(nazione, regione, zona){
  if(nazione) return nazione;
  // Prova prima regione, poi zona
  const candidates = [regione, zona].filter(Boolean);
  for(const candidate of candidates){
    const r = candidate.toLowerCase().trim()
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"") // rimuove accenti per match più robusto
      .replace(/\s+/g," ");
    if(!r) continue;
    // Match esatto (con e senza normalizzazione accenti)
    if(_REGIONE_TO_PAESE[r]) return _REGIONE_TO_PAESE[r];
    if(_REGIONE_TO_PAESE[candidate.toLowerCase().trim()]) return _REGIONE_TO_PAESE[candidate.toLowerCase().trim()];
    // Match parziale: la chiave è contenuta nel testo o viceversa
    const keys = Object.keys(_REGIONE_TO_PAESE);
    for(const key of keys){
      const normKey = key.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
      if(r.includes(normKey) || normKey.includes(r)) return _REGIONE_TO_PAESE[key];
    }
  }
  return "";
}

function fmt(n){return _eur.format(n||0)}
function fmtN(n,d=2){return (d===0?_num0:d===1?_num1:_num2).format(n||0)}
// Arrotonda al €0.50 superiore (per prezzi visualizzati, non dati grezzi)
function round50(n){return Math.ceil(n||0)}
function fmtRound(n){return fmt(round50(n))}
function today(){return new Date().toISOString().split("T")[0]}
function esc(v){return `"${String(v??'').replace(/"/g,'""')}"`}
function h(s){return String(s??'').replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}

function calcValore(w){
  if(w.lots?.length) return w.lots.reduce((s,l)=>s+(parseFloat(l.prezzoAcq)||0)*(parseInt(l.qtyRimanente)||0),0);
  return (parseFloat(w.prezzoAcq)||0)*(parseInt(w.giacenza)||0);
}
function calcValoreIva(w){
  if(w.lots?.length) return w.lots.reduce((s,l)=>s+(parseFloat(l.prezzoAcq)||0)*(1+(parseInt(l.iva)||22)/100)*(parseInt(l.qtyRimanente)||0),0);
  return calcValore(w)*(1+(parseInt(w.iva)||22)/100);
}
function calcPrezzoMedioLotti(w){
  if(!w.lots?.length) return parseFloat(w.prezzoAcq)||0;
  const totQty=w.lots.reduce((s,l)=>s+(parseInt(l.qtyRimanente)||0),0);
  if(!totQty) return parseFloat(w.prezzoAcq)||0;
  return w.lots.reduce((s,l)=>s+(parseFloat(l.prezzoAcq)||0)*(parseInt(l.qtyRimanente)||0),0)/totQty;
}
function calcCostoIvaBottiglia(w){
  return calcPrezzoMedioLotti(w)*(1+(parseInt(w.iva)||22)/100);
}
function calcMargineBottiglia(w){
  const carta=parseFloat(w.prezzoCarta)||0;
  const c=calcCostoIvaBottiglia(w);
  if(!carta||!c) return null;
  return carta-c;
}
function calcMarginePerc(w){
  const carta=parseFloat(w.prezzoCarta)||0;
  const c=calcCostoIvaBottiglia(w);
  if(!carta||!c) return null;
  return ((carta-c)/carta)*100;
}
function calcValoreCarta(w){return (parseFloat(w.prezzoCarta)||0)*(parseInt(w.giacenza)||0)}
function calcRicavoMovimento(m,w){
  return m.qty*(parseFloat(w?.prezzoCarta)||0);
}
// M7: usa costoUnitarioIva salvato al momento dello scarico se presente,
// altrimenti fallback alla media ponderata lotti corrente (movimenti storici pre-fix).
function calcCostoMovimento(m,w){
  if(m.costoUnitarioIva) return m.qty * m.costoUnitarioIva;
  return m.qty * calcCostoIvaBottiglia(w||{});
}
function calcMargin(w){
  const a=parseFloat(w.prezzoAcq)||0, c=parseFloat(w.prezzoCarta)||0;
  if(!a||!c) return null;
  return ((c-a)/a*100);
}
function badge(t){return `<span class="badge badge-${t||'default'}">${h(t||'')}</span>`}
function margColor(mp){return mp===null?"var(--txt4)":mp>=50?"#30D158":mp>=30?"var(--amber)":"#FF453A"}

// ─── PRICE HISTORY ────────────────────────────────────────────────────────────
function _trackPriceChange(wine, newAcq, newCarta, source){
  const oldAcq  = parseFloat(wine.prezzoAcq)||0;
  const oldCarta= parseFloat(wine.prezzoCarta)||0;
  const na = newAcq  !== null ? (parseFloat(newAcq)||0)  : oldAcq;
  const nc = newCarta!== null ? (parseFloat(newCarta)||0) : oldCarta;
  if(na===oldAcq && nc===oldCarta) return wine;
  const entry={
    data: today(), ts: Date.now(), source: source||"manuale",
    prezzoAcq: na, prezzoCarta: nc,
    prevAcq: oldAcq, prevCarta: oldCarta
  };
  return {...wine, priceHistory:[...(wine.priceHistory||[]), entry]};
}

// ─── SUPABASE + PERSISTENCE ───────────────────────────────────────────────────
let _sb = null; // Supabase client instance
const DB_USER = "default"; // single-user key in all tables

function _setDbStatus(state, label){
  const dot = document.getElementById("db-dot");
  const lbl = document.getElementById("db-label");
  if(dot){ dot.className = "db-dot " + state; }
  if(lbl){ lbl.textContent = label; }
  const dbDiv = document.getElementById("db-status");
  if(dbDiv) dbDiv.style.cursor = state==="err" ? "pointer" : "default";
  // Sync mobile indicator
  const mobDot = document.getElementById("mob-db-dot");
  const mobLbl = document.getElementById("mob-db-label");
  if(mobDot) mobDot.className = "db-dot " + state;
  if(mobLbl) mobLbl.textContent = label;
  // Sync topbar indicator
  const topDot = document.getElementById("topbar-dot");
  const topLbl = document.getElementById("topbar-sync-label");
  if(topDot) topDot.className = "db-dot " + state;
  if(topLbl) topLbl.textContent = label;
}

function _initSupabase(){
  try{
    const url = localStorage.getItem("cm_sb_url");
    const key = localStorage.getItem("cm_sb_key");
    if(!url||!key){ _sb=null; _setDbStatus("off","Solo locale"); return false; }
    _sb = supabase.createClient(url, key);
    return true;
  }catch(e){ _sb=null; _setDbStatus("err","Errore init"); return false; }
}

// ── DB CONFIG MODAL ──────────────────────────────────────────────────────────
function saveTipologie(){
  const val = document.getElementById("cfg-tipologie").value;
  const arr = val.split("\n").map(s=>s.trim()).filter(Boolean);
  if(!arr.length) return notify("Inserisci almeno una tipologia","err");
  TIPOLOGIE.length = 0;
  arr.forEach(t=>TIPOLOGIE.push(t));
  _saveTipologie();
  notify("✓ Tipologie aggiornate");
  render();
}
function resetTipologie(){
  TIPOLOGIE.length = 0;
  TIPOLOGIE_DEFAULT.forEach(t=>TIPOLOGIE.push(t));
  _saveTipologie();
  document.getElementById("cfg-tipologie").value = TIPOLOGIE.join("\n");
  notify("✓ Tipologie ripristinate");
  render();
}
function openDbConfig(){
  document.getElementById("cfg-url").value = localStorage.getItem("cm_sb_url")||"";
  document.getElementById("cfg-key").value = localStorage.getItem("cm_sb_key")||"";
  document.getElementById("cfg-tipologie").value = TIPOLOGIE.join("\n");
  document.getElementById("cfg-test-result").textContent = "";
  document.getElementById("db-config-backdrop").classList.remove("hidden");
}
function closeDbConfig(e){
  if(e&&e.target!==document.getElementById("db-config-backdrop")) return;
  document.getElementById("db-config-backdrop").classList.add("hidden");
}
async function testDbConnection(){
  const url = _sanitizeSupabaseUrl(document.getElementById("cfg-url").value);
  const key = document.getElementById("cfg-key").value.trim();
  document.getElementById("cfg-url").value = url;
  const el = document.getElementById("cfg-test-result");
  if(!url||!key){ el.innerHTML='<span style="color:#FF453A">Inserisci URL e Anon Key</span>'; return; }
  el.innerHTML='<span style="color:var(--amber)">⏳ Test in corso…</span>';
  try{
    const client = supabase.createClient(url, key);
    const { error } = await client.from("cm_wines").select("user_id").limit(1);
    if(error) throw error;
    el.innerHTML='<span style="color:#30D158">✅ Connessione OK — tabella cm_wines trovata</span>';
  }catch(e){
    el.innerHTML=`<span style="color:#FF453A">❌ ${h(e.message||"Connessione fallita")}</span>`;
  }
}
function _sanitizeSupabaseUrl(url){
  // Rimuove automaticamente path aggiunti per errore (/rest/v1/, /auth/v1/, ecc.)
  return url.trim().replace(/\/(rest|auth|storage|realtime)\/v\d+\/?$/, '').replace(/\/$/, '');
}
function saveDbConfig(){
  const url = _sanitizeSupabaseUrl(document.getElementById("cfg-url").value);
  const key = document.getElementById("cfg-key").value.trim();
  document.getElementById("cfg-url").value = url;
  localStorage.setItem("cm_sb_url", url);
  localStorage.setItem("cm_sb_key", key);
  document.getElementById("db-config-backdrop").classList.add("hidden");
  _initSupabase();
  if(_sb){ notify("✅ Supabase configurato — ricarico dati…"); loadData(); }
  else notify("⚠️ Config rimossa — modalità locale","err");
}

// ── LOCAL BACKUP ──────────────────────────────────────────────────────────────
function _saveLocalBackup(snap){
  try{
    localStorage.setItem("cm_wines",JSON.stringify(snap?snap.wines:wines));
    localStorage.setItem("cm_movements",JSON.stringify(snap?snap.movements:movements));
    localStorage.setItem("cm_fallate",JSON.stringify(snap?snap.fallate:fallate));
    localStorage.setItem("cm_alert_soglie",JSON.stringify(snap?snap.soglie:alertSoglie));
    localStorage.setItem("cm_orders",JSON.stringify(snap?snap.orders:orders));
  }catch{}
}
function _loadLocalBackup(){
  try{const s=JSON.parse(localStorage.getItem("cm_wines")||"null");wines=(s||[]).map(v=>({...v,nazione:inferPaese(v.nazione,v.regione,v.zona)}))}catch{wines=[]}
  try{movements=JSON.parse(localStorage.getItem("cm_movements")||"[]")}catch{movements=[]}
  try{fallate=JSON.parse(localStorage.getItem("cm_fallate")||"[]")}catch{fallate=[]}
  try{alertSoglie=JSON.parse(localStorage.getItem("cm_alert_soglie")||"{}")}catch{alertSoglie={}}
  try{orders=JSON.parse(localStorage.getItem("cm_orders")||"[]")}catch{orders=[]}
  _migrateOrders();
  _migrateWines();
}
function _migrateOrders(){
  orders=orders.map(o=>{
    if(!o.referenze){
      return {...o,referenze:[{id:uid(),produttore:o.produttore||"",nomeVino:o.nomeVino||o.nome||"",tipologia:o.tipologia||"Rosso",prezzoAcq:o.prezzoAcq||0,iva:o.iva||22,qty:o.qty||1}]};
    }
    return o;
  });
}

function _migrateWines(){
  let changed = false;
  wines = wines.map(w => {
    let upd = {...w};
    // Imposta formato 0.75 a tutti i vini senza formato
    if(!upd.formato || upd.formato === ""){
      upd.formato = "0.75";
      changed = true;
    }
    // Arrotonda prezzoCarta all'intero se ha decimali
    const pc = parseFloat(upd.prezzoCarta)||0;
    if(pc > 0 && pc !== Math.round(pc)){
      upd.prezzoCarta = Math.round(pc);
      changed = true;
    }
    return upd;
  });
  // FIX T-B6: setTimeout per evitare chiamata pre-DOM al primo load
  if(changed) setTimeout(scheduleSave, 0);
}

// ── SUPABASE READ/WRITE ───────────────────────────────────────────────────────
// ── VERSION COUNTER (anti-sovrascrittura multi-dispositivo) ──────────────────
// Ogni salvataggio riuscito incrementa _localVersion. Prima di scrivere,
// _flushSave legge la versione remota: se è cambiata (un altro dispositivo ha
// salvato nel frattempo), avvisa l'utente invece di sovrascrivere silenziosamente.
let _localVersion = 0; // versione dell'ultimo caricamento/salvataggio riuscito

async function _sbUpsert(table, payload){
  if(!_sb) return;
  const { error } = await _sb.from(table).upsert(payload, {onConflict:"user_id"});
  if(error){ console.warn("Supabase upsert error:", table, error.message); throw error; }
}
async function _sbRead(table){
  if(!_sb) return null;
  const { data, error } = await _sb.from(table).select("data").eq("user_id", DB_USER);
  // FIX PERDITA DATI: in caso di ERRORE di lettura NON ritornare null (che a monte
  // diventerebbe [] e poi sovrascriverebbe la tabella vuota). Lancia, così
  // loadData/registraMovimentoMobile vanno in catch e mantengono il backup locale.
  if(error){ console.error(`_sbRead(${table}) error:`, error.message, error.code, error.details); throw error; }
  if(!data || data.length === 0) return null; // tabella legittimamente vuota
  // Se c'è una sola riga (caso normale) restituisce direttamente
  if(data.length === 1) return data[0].data ?? null;
  // Se ci sono più righe (struttura legacy divisa in attive/terminate), le unisce
  const merged = data.flatMap(row => {
    const d = row.data;
    if(Array.isArray(d)) return d;
    if(d && typeof d === 'object') return [d];
    return [];
  });
  console.warn(`_sbRead(${table}): trovate ${data.length} righe — unisco in un unico array di ${merged.length} elementi`);
  return merged.length > 0 ? merged : null;
}
async function _sbReadVersion(){
  if(!_sb) return null;
  try{
    const { data, error } = await _sb.from("cm_meta").select("version").eq("user_id", DB_USER).maybeSingle();
    if(error) return null;
    return data?.version ?? 0;
  }catch{ return null; }
}
async function _sbWriteVersion(v){
  if(!_sb) return;
  try{
    await _sb.from("cm_meta").upsert({user_id:DB_USER, version:v}, {onConflict:"user_id"});
  }catch{}
}

// ─── MOVIMENTI: LEDGER APPEND-ONLY (cm_movements_ledger) ─────────────────────────
// I movimenti NON vivono più in un blob JSONB sovrascritto per intero (causa
// storica di perdita scarichi: un client "indietro" riscriveva tutto l'array,
// azzerando giorni di scarichi). Ora ogni movimento è una RIGA in cm_movements_ledger
// (upsert per id; cancellazione = tombstone deleted=true). La sincronizzazione è
// a DELTA rispetto a una baseline PER-SESSIONE: un client può scrivere solo le
// righe che conosce e tombstonare solo quelle che aveva caricato. Non può
// fisicamente azzerare la storia che non ha mai visto. Questo elimina alla radice
// la classe di bug "scarichi persi".
let _movSyncBaseline = new Map(); // id -> hash dello stato sincronizzato l'ultima volta
let _movV2Available = false;       // true se la tabella cm_movements_ledger esiste ed è usabile

function _movHash(m){
  // hash stabile e cheap: chiavi ordinate, così un edit cambia l'hash ma un
  // semplice riordino di proprietà non genera scritture inutili.
  try{ const k=Object.keys(m).sort(); return JSON.stringify(k.map(x=>[x,m[x]])); }
  catch{ return JSON.stringify(m); }
}
function _chunk(arr,n){ const o=[]; for(let i=0;i<arr.length;i+=n) o.push(arr.slice(i,i+n)); return o; }

// Riconosce l'errore "tabella inesistente" (v2 non ancora creata su Supabase).
function _isMissingTableErr(error){
  const code=(error&&error.code)||""; const msg=((error&&error.message)||"").toLowerCase();
  return code==="42P01" || code==="PGRST205" || code==="PGRST204"
    || msg.includes("does not exist") || msg.includes("could not find the table")
    || msg.includes("relation") && msg.includes("does not exist");
}

// Carica le righe (vive + tombstone) da cm_movements_ledger.
// Se la tabella non esiste ancora, ritorna {_missing:true} → l'app usa il blob legacy.
async function _loadMovementsV2(){
  const { data, error } = await _sb.from("cm_movements_ledger")
    .select("id,payload,deleted").eq("user_id", DB_USER);
  if(error){
    if(_isMissingTableErr(error)) return { _missing:true };
    throw error; // errore transitorio reale → gestito a monte (backup locale)
  }
  return data || [];
}

// Seed una-tantum: copia il vecchio blob cm_movements nella tabella v2.
// Garantisce che ogni payload abbia un id (i movimenti legacy potrebbero non averlo).
async function _seedMovementsV2(legacyArr){
  const rows = legacyArr.map(m => {
    const withId = (m && m.id) ? m : {...m, id: uid()};
    return { id: withId.id, user_id: DB_USER, payload: withId, deleted: false };
  });
  for(const c of _chunk(rows, 500)){
    const { error } = await _sb.from("cm_movements_ledger").upsert(c, {onConflict:"id"});
    if(error) throw error;
  }
  return rows;
}

// Sincronizza i movimenti a DELTA verso cm_movements_ledger (append-only-safe).
// Se la tabella v2 non esiste ancora, ripiega sul blob legacy (comportamento
// pre-refactor) così i movimenti continuano comunque a persistere senza rotture.
async function _flushMovementsV2(){
  if(!_sb) return;
  if(!_movV2Available){
    await _sbUpsert("cm_movements", { user_id:DB_USER, data:movements });
    return;
  }
  const cur = new Map(movements.map(m => [m.id, _movHash(m)]));
  const upserts = movements.filter(m => _movSyncBaseline.get(m.id) !== cur.get(m.id));
  const deletes = [..._movSyncBaseline.keys()].filter(id => !cur.has(id));
  for(const c of _chunk(upserts, 500)){
    const rows = c.map(m => ({ id:m.id, user_id:DB_USER, payload:m, deleted:false }));
    const { error } = await _sb.from("cm_movements_ledger").upsert(rows, {onConflict:"id"});
    if(error) throw error;
  }
  for(const c of _chunk(deletes, 500)){
    const { error } = await _sb.from("cm_movements_ledger")
      .update({ deleted:true }).in("id", c).eq("user_id", DB_USER);
    if(error) throw error;
  }
  _movSyncBaseline = cur; // baseline = ciò che abbiamo appena sincronizzato
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
let saveTimer = null;
// ── SAVE MUTEX ────────────────────────────────────────────────────────────────
// Evita race condition: se un'upsert verso Supabase è in volo e arriva una nuova
// modifica, il flag _savePending garantisce un secondo salvataggio non appena
// il primo si conclude — senza sovrascrivere lo stato con dati stantii.
let _saveInFlight = false; // true mentre awaita Promise.all verso Supabase
let _savePending  = false; // true se è arrivata almeno 1 modifica durante l'invio

async function _flushSave(){
  if(_saveInFlight){ _savePending = true; return; } // accoda — non droppa

  if(!_sb){ return; }

  _saveInFlight = true;
  _savePending  = false;
  _setDbStatus("sync","Sincronizzazione…");

  // Cattura snapshot immutabile DEEP dello stato corrente prima dell'await.
  // wines.slice() è shallow: gli oggetti dentro sono condivisi per riferimento.
  // JSON round-trip garantisce che mutazioni successive non inquinino lo snapshot.
  const snapshot = JSON.parse(JSON.stringify({
    wines, movements, fallate,
    soglie: alertSoglie,
    orders,
  }));

  try{
    // 1) GATE DI VERSIONE — PRIMA di scrivere qualsiasi cosa (blob O movimenti).
    //    Se la versione remota è più alta, questa sessione è stantia: non deve
    //    scrivere NIENTE. Scrivere solo i movimenti (come faceva l'ordine precedente)
    //    e poi scartare il blob faceva divergere giacenza e movimenti → è la causa
    //    degli "scarichi che resuscitano" (movimento salvato ma riduzione di giacenza
    //    persa). Ricarica lo stato coerente e chiedi di riapplicare.
    const remoteVersion = await _sbReadVersion();
    if(remoteVersion !== null && remoteVersion > _localVersion){
      _setDbStatus("sync","Aggiornamento da altra sessione…");
      notify("⚠️ I dati erano stati aggiornati da un'altra sessione: li ho ricaricati. Ricontrolla e riapplica l'ultima modifica.","err");
      _saveInFlight = false; // libera il mutex prima del reload
      _savePending  = false; // scarta la coda: lo stato locale stantio non va scritto
      await loadData();      // riallinea _localVersion, stato e baseline movimenti
      return;
    }

    // 2) BLOB (wines/fallate/soglie/orders) + versione. Il blob contiene la giacenza.
    const newVersion = (_localVersion||0) + 1;
    await Promise.all([
      _sbUpsert("cm_wines",    { user_id:DB_USER, data:snapshot.wines }),
      _sbUpsert("cm_fallate",  { user_id:DB_USER, data:snapshot.fallate }),
      _sbUpsert("cm_soglie",   { user_id:DB_USER, data:snapshot.soglie }),
      _sbUpsert("cm_orders",   { user_id:DB_USER, data:snapshot.orders }),
      _sbWriteVersion(newVersion),
    ]);
    _localVersion = newVersion;

    // 3) MOVIMENTI sul ledger append-only — SOLO dopo che la giacenza è committata,
    //    così movimento e riduzione di giacenza non possono divergere. Se il gate
    //    sopra avesse bloccato, qui non arriviamo: nessun movimento orfano.
    //    Resta comunque delta-safe (upsert per id + tombstone): una sessione stantia
    //    non può cancellare la storia altrui, perché non arriva mai a questo punto.
    await _flushMovementsV2();
    _setDbStatus("ok","Sincronizzato");
  }catch(e){
    _setDbStatus("err","Errore sync");
    notify("⚠️ Salvataggio remoto fallito — dati locali ok","err");
  }finally{
    _saveInFlight = false;
    if(_savePending){ _savePending = false; _flushSave(); }
  }
}

function scheduleSave(){
  clearTimeout(saveTimer);
  _saveLocalBackup(); // backup locale ottimistico e immediato (sincrono)
  _setDbStatus("pending","Da sincronizzare…"); // PATCH: indica stato pendente
  saveTimer = setTimeout(_flushSave, 400);
}

async function forceSave(){
  clearTimeout(saveTimer);
  if(!_sb){ notify("⚠️ Nessuna connessione Supabase","err"); return; }
  _setDbStatus("sync","Sincronizzazione…");
  // Snapshot immutabile DEEP prima dell'await
  const snapshot = JSON.parse(JSON.stringify({
    wines, movements, fallate,
    soglie: alertSoglie,
    orders,
  }));
  try{
    _saveLocalBackup(snapshot);
    await Promise.all([
      _sbUpsert("cm_wines",    { user_id:DB_USER, data:snapshot.wines }),
      _sbUpsert("cm_fallate",  { user_id:DB_USER, data:snapshot.fallate }),
      _sbUpsert("cm_soglie",   { user_id:DB_USER, data:snapshot.soglie }),
      _sbUpsert("cm_orders",   { user_id:DB_USER, data:snapshot.orders }),
    ]);
    const newVer = (_localVersion||0) + 1;
    await _sbWriteVersion(newVer);
    _localVersion = newVer;
    await _flushMovementsV2(); // movimenti sul ledger, dopo il blob giacenza
    _setDbStatus("ok","Sincronizzato");
    notify("✅ Sync forzato — dati inviati a Supabase");
  }catch(e){
    _setDbStatus("err","Errore sync");
    notify("⚠️ Sync fallito: "+e.message,"err");
  }
}

async function loadData(){
  if(!_sb){
    _loadLocalBackup();
    _setDbStatus("off","Solo locale");
    if(_mobActive){ _renderMobList(); _renderMobLog(); updateSidebar(); } else render();
    return;
  }
  _setDbStatus("sync","Caricamento…");
  try{
    const [w,f,s,o,ver,movRows] = await Promise.all([
      _sbRead("cm_wines"), _sbRead("cm_fallate"),
      _sbRead("cm_soglie"), _sbRead("cm_orders"), _sbReadVersion(),
      _loadMovementsV2()
    ]);
    wines       = (w ?? []).map(v=>({...v, nazione: inferPaese(v.nazione, v.regione, v.zona)}));
    fallate     = f ?? [];
    alertSoglie = s ?? {};
    orders      = o ?? [];
    _localVersion = ver ?? 0;

    // MOVIMENTI dal ledger append-only cm_movements_ledger.
    if(movRows && movRows._missing){
      // Tabella v2 non ancora creata su Supabase: l'app NON si rompe, resta sul
      // vecchio blob finché non esegui la migration SQL. Nessuna perdita di dati.
      _movV2Available = false;
      const legacy = await _sbRead("cm_movements");
      movements = legacy ?? [];
      _movSyncBaseline = new Map();
    } else {
      _movV2Available = true;
      // Seed una-tantum: se la tabella v2 è vuota ma esiste il vecchio blob, migra.
      let rows = movRows;
      if(rows.length === 0){
        const legacy = await _sbRead("cm_movements"); // null se vuoto/assente
        if(legacy && legacy.length){ rows = await _seedMovementsV2(legacy); }
      }
      const live = rows.filter(r => !r.deleted);
      movements = live.map(r => r.payload)
        .sort((a,b)=> (b.ts||0)-(a.ts||0) || String(b.data||"").localeCompare(String(a.data||"")));
      _movSyncBaseline = new Map(live.map(r => [r.payload.id, _movHash(r.payload)]));
    }

    _migrateOrders();
    _migrateWines();
    _saveLocalBackup(); // update local cache with remote data
    _setDbStatus("ok","Connesso");
    if(_mobActive){
      _renderMobList();
      // Se la lista è ancora vuota dopo il caricamento, potrebbe essere un problema di RLS/user_id
      if(wines.length === 0){
        const list = document.getElementById("mob-list");
        if(list && list.innerHTML === "") list.innerHTML = `<div style="text-align:center;padding:32px 24px;color:var(--txt4);font-size:11px;line-height:1.8">⚠️ Supabase connesso ma nessun dato trovato.<br><span style="font-size:10px;opacity:.7">Verifica l'USER_ID nella config e le policy RLS.<br>Apri la console (F12) per i dettagli.</span></div>`;
      }
      _renderMobLog(); updateSidebar();
    } else render(); // re-render after async load
  }catch(e){
    _setDbStatus("err","Errore lettura");
    notify("⚠️ DB non raggiungibile — carico backup locale","err");
    _loadLocalBackup();
    if(_mobActive){ _renderMobList(); _renderMobLog(); updateSidebar(); } else render();
  }
}

// storico ordini filtri (in-memory, no persist)
let storicoQ="", storicoForn="", storicoDataDa="", storicoDataA="";


function renderBulkBar(mode, allIds){
  if(selMode!==mode) return "";
  // Salva gli ID visibili nella variabile globale per toggleSelAll
  _selAllIds = allIds||[];
  const n=selIds.size;
  const deleteLabel = mode==="wines"?"Elimina vini":mode==="movimenti"?"Elimina movimenti":"Elimina ordini";
  const deleteFn = mode==="wines"?"bulkDeleteWines()":mode==="movimenti"?"bulkDeleteMovimenti()":"bulkDeleteOrdini()";
  const editFn = `openBulkEditModal('${mode}')`;
  return `<div class="bulk-bar" id="bulk-bar">
    <span class="bulk-bar-count" id="bulk-count">${n} selezionat${n===1?"o":"i"}</span>
    <div class="bulk-bar-actions" id="bulk-bar-actions">
      <button class="btn-danger${n===0?' bulk-btn-disabled':''}" id="bulk-btn-delete" onclick="${deleteFn}" ${n===0?'disabled':''}>🗑️ ${deleteLabel}</button>
      <button class="btn-bulk-edit${n===0?' bulk-btn-disabled':''}" id="bulk-btn-edit" onclick="${editFn}" ${n===0?'disabled':''}>✏️ Modifica campi</button>
      ${mode==='wines'?`<button class="btn-bulk-edit${n===0?' bulk-btn-disabled':''}" id="bulk-btn-ordine" onclick="creaBasiOrdineDatiSelezionati()" ${n===0?'disabled':''} style="background:rgba(48,209,88,.12);border-color:rgba(48,209,88,.3);color:#30D158">🛒 Crea Basi Ordine</button>`:''}
    </div>
    <button class="btn-cancel-sel" onclick="exitSel()">✕ Annulla selezione</button>
  </div>`;
}

// ─── NOTIFICATION ─────────────────────────────────────────────────────────────
function notify(msg,type="ok"){
  clearTimeout(notifTimer);
  const el=document.getElementById("notif");
  el.textContent=msg; el.className=type; el.style.display="flex";
  notifTimer=setTimeout(()=>{el.style.display="none"},3000);
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────
function togglePw(){
  const i=document.getElementById("pw-input");
  i.type=i.type==="password"?"text":"password";
}

// Rate limiting: 3 tentativi falliti → lockout 30s (raddoppia ad ogni ciclo, max 10min)
const _loginRL = { attempts:0, lockedUntil:0, cooldown:30 };
function _isLoginLocked(){
  if(_loginRL.lockedUntil && Date.now() < _loginRL.lockedUntil) return true;
  if(_loginRL.lockedUntil && Date.now() >= _loginRL.lockedUntil){
    _loginRL.lockedUntil=0; _loginRL.attempts=0;
  }
  return false;
}
function _loginLockoutTick(){
  const err=document.getElementById("pw-err");
  const btn=document.querySelector(".login-box button[onclick*='doLogin']")||document.querySelector(".login-box button:last-of-type");
  const remaining=Math.ceil((_loginRL.lockedUntil-Date.now())/1000);
  if(remaining<=0){
    if(err) err.textContent="Password errata.";
    if(btn){ btn.disabled=false; btn.textContent="Accedi"; btn.style.opacity=""; }
    return;
  }
  if(err) err.textContent=`Troppi tentativi. Riprova tra ${remaining}s`;
  if(btn) btn.textContent=`Attendi ${remaining}s`;
  setTimeout(_loginLockoutTick, 1000);
}

async function doLogin(){
  if(_isLoginLocked()){ _loginLockoutTick(); return; }

  const pw=document.getElementById("pw-input").value;
  const enc=new TextEncoder();
  const buf=await crypto.subtle.digest("SHA-256",enc.encode(pw));
  const hash=Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
  if(hash===PASSWORD_HASH){
    _loginRL.attempts=0; _loginRL.lockedUntil=0; _loginRL.cooldown=30;
    sessionStorage.setItem("cm_logged","1");
    document.getElementById("login-screen").style.display="none";
    _applySidebarState();
    _initSupabase();
    if(_isMobile()){
      enterMobileMode();
      loadData();
    } else {
      const app=document.getElementById("app");
      app.classList.remove("hidden"); app.style.display="flex";
      loadData(); go("dashboard");
    }
  } else {
    _loginRL.attempts++;
    const err=document.getElementById("pw-err"); err.classList.remove("hidden");
    const box=document.querySelector(".login-box");
    box.classList.add("shake"); setTimeout(()=>box.classList.remove("shake"),400);
    document.getElementById("pw-input").value="";
    if(_loginRL.attempts>=3){
      _loginRL.lockedUntil=Date.now()+(_loginRL.cooldown*1000);
      _loginRL.cooldown=Math.min(_loginRL.cooldown*2, 600); // max 10min
      _loginRL.attempts=0;
      const btn=document.querySelector(".login-box button[onclick*='doLogin']")||document.querySelector(".login-box button:last-of-type");
      if(btn){ btn.disabled=true; btn.style.opacity="0.5"; }
      _loginLockoutTick();
    } else {
      err.textContent=`Password errata. Tentativo ${_loginRL.attempts}/3.`;
    }
  }
}
document.getElementById("pw-input").addEventListener("keydown",e=>{if(e.key==="Enter")doLogin()});

// ── PROTEZIONE USCITA: flush pendente su pagehide/beforeunload ───────────────
// Se saveTimer è attivo (debounce non scattato) e l'utente chiude/ricarica la
// pagina, i dati sarebbero persi su Supabase (localStorage è già aggiornato).
// pagehide è più affidabile di beforeunload su mobile Safari.
window.addEventListener("pagehide", () => {
  if(saveTimer){ clearTimeout(saveTimer); }
  // Tenta flush sincrono via sendBeacon se disponibile, altrimenti localStorage è già ok
  if(_sb && typeof navigator.sendBeacon === "function"){
    const snap = {
      wines: wines, movements: movements, fallate: fallate,
      orders: orders, soglie: alertSoglie
    };
    // sendBeacon non supporta JSON arbitrario verso Supabase — salviamo almeno localStorage
    _saveLocalBackup(snap);
  }
});
window.addEventListener("beforeunload", (e) => {
  if(saveTimer){
    // C'è un save pendente non ancora inviato a Supabase
    e.preventDefault();
    e.returnValue = "Ci sono modifiche non ancora sincronizzate con il database. Attendere un momento prima di chiudere.";
    // Tenta flush immediato (non garantito ma aumenta la probabilità)
    clearTimeout(saveTimer);
    _flushSave();
    return e.returnValue;
  }
});

// ─── SIDEBAR COLLAPSE ─────────────────────────────────────────────────────────
let _sidebarCollapsed = localStorage.getItem("cm_sidebar_collapsed") === "1";
function toggleSidebar(){
  _sidebarCollapsed = !_sidebarCollapsed;
  localStorage.setItem("cm_sidebar_collapsed", _sidebarCollapsed ? "1" : "0");
  _applySidebarState();
}
function _applySidebarState(){
  const sb = document.getElementById("sidebar");
  const main = document.getElementById("main");
  const icon = document.getElementById("sidebar-toggle-icon");
  if(_sidebarCollapsed){
    sb.classList.add("collapsed");
    main.classList.add("sidebar-collapsed");
    if(icon) icon.textContent = "▶";
  } else {
    sb.classList.remove("collapsed");
    main.classList.remove("sidebar-collapsed");
    if(icon) icon.textContent = "◀";
  }
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
const SECTION_TITLES={dashboard:"Plancia",inventario:"Inventario Vini","scarico-serata":"🍾 Scarico Serata",movimenti:"Carico / Scarico",fallate:"Gestione Fallate",ordini:"Ordini Fornitore",export:"Export & Bilancio",impostazioni:"⚙️ Impostazioni"};
function go(s){
  if(s==="analytics") s="dashboard"; // sezioni fuse in "Plancia"
  section=s;
  if(selMode) exitSel(); // NAV-03: resetta selezione multipla al cambio sezione
  if(s!=="inventario"){ filterTipo="tutti"; filterVitigni.clear(); filterFormato="tutti"; filterDistrib="tutti"; filterProduttore="tutti"; filterRegione="tutti"; filterNazione="tutti"; filterGiacenza="tutti"; _hideTopbarActions(); }
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.section===s));
  document.getElementById("topbar-title").textContent=SECTION_TITLES[s]||s;
  document.getElementById("btn-add-wine").classList.add("hidden");
  destroyCharts();
  render();
}
function destroyCharts(){
  Object.values(activeCharts).forEach(c=>{try{c.destroy()}catch{}});
  activeCharts={};
}

// Ricalcola altezza tabella inventario al resize finestra
window.addEventListener("resize", ()=>{ if(section==="inventario") _setInvScrollHeight(); });

// Auto-login se sessione ancora valida
if(sessionStorage.getItem("cm_logged")==="1"){
  document.getElementById("login-screen").style.display="none";
  _applySidebarState();
  _initSupabase();
  // FIX MODAL: assicura che tutti i backdrop esistenti nell'HTML chiudano solo
  // al click sul backdrop stesso, non propagato dall'interno
  document.querySelectorAll(".modal-backdrop").forEach(bd=>{
    if(bd._patchedClose) return;
    bd._patchedClose = true;
    const origOnclick = bd.getAttribute("onclick");
    if(origOnclick){
      // Rimuovi onclick inline e rimpiazza con addEventListener filtrato
      const closeFnName = origOnclick.replace(/\(.*\)/, "").trim();
      bd.removeAttribute("onclick");
      bd.addEventListener("click", e => {
        if(e.target === bd && window[closeFnName]) window[closeFnName]();
      });
    }
    // Assicura stopPropagation su .modal figlio
    const inner = bd.querySelector(".modal");
    if(inner && !inner._patchedStop){
      inner._patchedStop = true;
      inner.addEventListener("click", e => e.stopPropagation());
    }
  });
  if(_isMobile()){
    enterMobileMode();
    loadData();
  } else {
    const app=document.getElementById("app");
    app.classList.remove("hidden"); app.style.display="flex";
    loadData(); go("dashboard");
  }
}

// ─── TOPBAR CONTEXT ACTIONS ───────────────────────────────────────────────────
var _selectedWineId = null;

function selectWineRow(id){
  // Deseleziona precedente
  document.querySelectorAll(".inv-table tr.row-selected").forEach(r=>r.classList.remove("row-selected"));
  if(_selectedWineId===id){
    // secondo click sulla stessa riga → deseleziona
    _selectedWineId=null; _updateTopbarActions(null); return;
  }
  _selectedWineId=id;
  const row=document.querySelector(`.inv-table tr[data-wine-id="${id}"]`);
  if(row) row.classList.add("row-selected");
  _updateTopbarActions(id);
}

function _updateTopbarActions(id){ /* tba buttons removed — noop */ }

// ─── INVENTORY ROW DOUBLE-CLICK DROPDOWN ─────────────────────────────────────
// ─── INVENTORY CONTEXT MENUS (single-row double-click + bulk right-click) ─────
(function _setupInvDropdown(){
  // ── Single-row menu (double-click) ──────────────────────────────────────────
  const menu = document.createElement('div');
  menu.id = 'inv-row-menu';
  menu.style.cssText = 'position:fixed;z-index:9999;min-width:172px;background:var(--bg2,#1c1917);border:1px solid var(--border2,rgba(68,64,60,.6));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.04);padding:4px 0;display:none;user-select:none';
  menu.innerHTML = `
    <div data-action="edit"  style="padding:9px 14px;cursor:pointer;font-size:12px;color:var(--txt2,#e7e5e4);display:flex;align-items:center;gap:9px;transition:background .1s">✏️ <span>Modifica scheda</span></div>
    <div data-action="note"  style="padding:9px 14px;cursor:pointer;font-size:12px;color:var(--txt2,#e7e5e4);display:flex;align-items:center;gap:9px;transition:background .1s">📝 <span>Nota veloce</span></div>
    <div data-action="rett"  style="padding:9px 14px;cursor:pointer;font-size:12px;color:#30D158;display:flex;align-items:center;gap:9px;transition:background .1s">⚖️ <span>Rettifica giacenza</span></div>
    <div style="height:1px;background:var(--border,rgba(68,64,60,.4));margin:3px 8px"></div>
    <div data-action="delete" style="padding:9px 14px;cursor:pointer;font-size:12px;color:#FF453A;display:flex;align-items:center;gap:9px;transition:background .1s">🗑️ <span>Elimina voce</span></div>
  `;
  document.body.appendChild(menu);

  // ── Bulk-selection menu (right-click when selIds.size > 0) ──────────────────
  const bulkMenu = document.createElement('div');
  bulkMenu.id = 'inv-bulk-menu';
  bulkMenu.style.cssText = 'position:fixed;z-index:9999;min-width:200px;background:var(--bg2,#1c1917);border:1px solid var(--border2,rgba(68,64,60,.6));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.04);padding:4px 0;display:none;user-select:none';
  document.body.appendChild(bulkMenu);

  function _rebuildBulkMenu(){
    const n = selIds.size;
    bulkMenu.innerHTML = `
      <div style="padding:6px 14px 4px;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt4,#a8a29e);font-weight:700">${n} vino${n===1?'':'i'} selezionat${n===1?'o':'i'}</div>
      <div style="height:1px;background:var(--border,rgba(68,64,60,.4));margin:3px 8px 5px"></div>
      <div data-bulk="edit"    style="padding:9px 14px;cursor:pointer;font-size:12px;color:var(--txt2,#e7e5e4);display:flex;align-items:center;gap:9px;transition:background .1s">✏️ <span>Modifica campi</span></div>
      <div data-bulk="ordine"  style="padding:9px 14px;cursor:pointer;font-size:12px;color:#30D158;display:flex;align-items:center;gap:9px;transition:background .1s">🛒 <span>Crea basi ordine</span></div>
      <div style="height:1px;background:var(--border,rgba(68,64,60,.4));margin:3px 8px"></div>
      <div data-bulk="delete"  style="padding:9px 14px;cursor:pointer;font-size:12px;color:#FF453A;display:flex;align-items:center;gap:9px;transition:background .1s">🗑️ <span>Elimina selezionati</span></div>
      <div style="height:1px;background:var(--border,rgba(68,64,60,.4));margin:3px 8px"></div>
      <div data-bulk="cancel"  style="padding:8px 14px;cursor:pointer;font-size:12px;color:var(--txt4,#a8a29e);display:flex;align-items:center;gap:9px;transition:background .1s">✕ <span>Annulla selezione</span></div>
    `;
    // hover via delegation — no listener accumulation (click handler is on bulkMenu, set once below)
    bulkMenu.querySelectorAll('[data-bulk]').forEach(item=>{
      item.addEventListener('mouseenter',()=>item.style.background='rgba(255,255,255,.06)');
      item.addEventListener('mouseleave',()=>item.style.background='');
    });
  }

  // Bulk menu click — delegated, attached ONCE to the container
  bulkMenu.addEventListener('click', e=>{
    const action = e.target.closest('[data-bulk]')?.dataset.bulk;
    if(!action) return;
    closeBulkMenu();
    if(action==='edit')   openBulkEditModal('wines');
    if(action==='ordine') creaBasiOrdineDatiSelezionati();
    if(action==='delete') bulkDeleteWines();
    if(action==='cancel') exitSel();
  });

  let _targetId = null;

  function positionMenu(el, x, y){
    el.style.display='block';
    const r=el.getBoundingClientRect();
    const VW=window.innerWidth, VH=window.innerHeight;
    if(x+r.width>VW) x=VW-r.width-8;
    if(y+r.height>VH) y=VH-r.height-8;
    el.style.left=x+'px'; el.style.top=y+'px';
  }
  function closeMenu(){ menu.style.display='none'; _targetId=null; }
  function closeBulkMenu(){ bulkMenu.style.display='none'; }

  menu.querySelectorAll('[data-action]').forEach(item=>{
    item.addEventListener('mouseenter',()=>item.style.background='rgba(255,255,255,.06)');
    item.addEventListener('mouseleave',()=>item.style.background='');
  });

  menu.addEventListener('click', e=>{
    const action=e.target.closest('[data-action]')?.dataset.action;
    if(!action||!_targetId) return;
    closeMenu();
    if(action==='edit')   openWineModal(_targetId);
    if(action==='note')   openNoteVeloce(_targetId);
    if(action==='rett')   openRettificaGiacenza(_targetId);
    if(action==='delete') deleteWine(_targetId);
  });

  document.addEventListener('click', e=>{
    if(menu.style.display!=='none'&&!menu.contains(e.target)) closeMenu();
    if(bulkMenu.style.display!=='none'&&!bulkMenu.contains(e.target)) closeBulkMenu();
  }, true);

  document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ closeMenu(); closeBulkMenu(); }});

  // Double-click → single-row menu
  document.addEventListener('dblclick', e=>{
    const tr=e.target.closest('.inv-table tr[data-wine-id]');
    if(!tr) return;
    if(e.target.closest('button,input,select,textarea')) return;
    e.preventDefault(); e.stopPropagation();
    closeBulkMenu();
    _targetId=tr.dataset.wineId;
    selectWineRow(_targetId);
    positionMenu(menu, e.clientX, e.clientY);
  });

  // Right-click on inv table row
  document.addEventListener('contextmenu', e=>{
    const tr=e.target.closest('.inv-table tr[data-wine-id]');
    if(!tr) return;
    e.preventDefault();
    const wineId=tr.dataset.wineId;
    if(selMode==='wines' && selIds.size>0){
      // Bulk menu: se il right-click è su una riga non selezionata, aggiungila
      if(!selIds.has(wineId)){ toggleSel(wineId); _updateBulkBar(); }
      closeMenu();
      _rebuildBulkMenu();
      positionMenu(bulkMenu, e.clientX, e.clientY);
    } else {
      // Nessuna selezione attiva: comporta come double-click (single-row menu)
      closeBulkMenu();
      _targetId=wineId;
      selectWineRow(_targetId);
      positionMenu(menu, e.clientX, e.clientY);
    }
  });

  // Ctrl+Click (Mac: Cmd+Click) → entra in selezione multipla e seleziona riga
  document.addEventListener('click', e=>{
    const tr=e.target.closest('.inv-table tr[data-wine-id]');
    if(!tr) return;
    if(e.target.closest('button,input,select,textarea,.cb-col')) return;
    if(!(e.ctrlKey||e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const wineId=tr.dataset.wineId;
    if(selMode!=='wines'){
      // enterSel fa render() — aggiunge l'id prima così la checkbox risulta checked
      selIds.add(wineId);
      selMode='wines';
      render();
    } else {
      toggleSel(wineId); _updateBulkBar();
    }
  });
})();

function openRettificaGiacenza(id){
  const w=wines.find(x=>x.id===id);
  if(!w) return;
  const giacAttuale=parseInt(w.giacenza)||0;
  const bd=document.createElement("div");
  bd.className="modal-backdrop";
  bd.id="rett-backdrop";
  bd.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:40;display:flex;align-items:center;justify-content:center;padding:16px";
  bd.innerHTML=`
    <div class="modal" style="max-width:380px" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>⚖️ Rettifica Giacenza</h2>
        <button style="font-size:18px;color:var(--txt3)" onclick="document.getElementById('rett-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div style="font-size:13px;font-weight:500;color:var(--txt);margin-bottom:4px">${h(w.nome)}</div>
        <div style="font-size:11px;color:var(--txt4);margin-bottom:20px">${h(w.produttore||'')}${w.annata?' · '+h(w.annata):''}</div>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding:14px;background:var(--bg3);border-radius:var(--radius-sm)">
          <div style="text-align:center;flex:1">
            <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt4);margin-bottom:4px">Giacenza attuale</div>
            <div style="font-family:'Montserrat',sans-serif;font-size:2rem;font-weight:300;color:var(--amber)">${giacAttuale}</div>
          </div>
          <div style="font-size:20px;color:var(--txt4)">→</div>
          <div style="text-align:center;flex:1">
            <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt4);margin-bottom:4px">Giacenza reale</div>
            <input id="rett-qty" type="number" min="0" step="1" value="${giacAttuale}"
              class="form-input" style="text-align:center;font-family:'Montserrat',sans-serif;font-size:1.6rem;font-weight:300;color:#30D158;width:100%;padding:6px"
              oninput="document.getElementById('rett-delta').textContent=_rettDelta(this.value,${giacAttuale})">
          </div>
        </div>
        <div id="rett-delta" style="text-align:center;font-size:12px;color:var(--txt3);margin-bottom:16px">${_rettDelta(giacAttuale,giacAttuale)}</div>
        <div class="form-row">
          <label class="form-label">Nota (opzionale)</label>
          <input id="rett-note" class="form-input" placeholder="es. Inventario fisico 04/06/2026">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-outline" onclick="document.getElementById('rett-backdrop').remove()">Annulla</button>
        <button class="btn-primary" onclick="_confirmRettifica('${id}',${giacAttuale})">✓ Conferma rettifica</button>
      </div>
    </div>`;
  bd.addEventListener("click", function(e){ if(e.target===bd) bd.remove(); });
  document.body.appendChild(bd);
  setTimeout(()=>document.getElementById("rett-qty")?.focus(),80);
}

function _rettDelta(newVal, attuale){
  const n=parseInt(newVal)||0, diff=n-attuale;
  if(diff===0) return "Nessuna variazione";
  const sign=diff>0?"+":"";
  const col=diff>0?"#30D158":"#FF453A";
  return `<span style="color:${col};font-weight:600">${sign}${diff} bt</span> — verrà registrato un movimento di ${diff>0?"<b>carico</b>":"<b>scarico</b>"}`;
}

function _confirmRettifica(id, giacAttuale){
  const newQty=parseInt(document.getElementById("rett-qty").value);
  const nota=document.getElementById("rett-note").value.trim();
  if(isNaN(newQty)||newQty<0){ notify("Quantità non valida","err"); return; }
  const diff=newQty-giacAttuale;
  if(diff===0){ document.getElementById("rett-backdrop")?.remove(); return; }
  const w=wines.find(x=>x.id===id);
  if(!w) return;
  // Crea movimento
  const mov={
    id: uid(), wineId: id, wineName: w.nome, produttore: w.produttore||"",
    nazione: w.nazione||"", annata: w.annata||"",
    tipo: diff>0?"carico":"scarico",
    qty: Math.abs(diff),
    data: new Date().toISOString().slice(0,10),
    note: nota || "Rettifica giacenza inventario",
    fornitore:"", fattura:""
  };
  movements.push(mov);
  // FIX T-B5: aggiorna anche i lotti FIFO, non solo la giacenza.
  // Carico → nuovo lotto; scarico → consuma FIFO dai lotti esistenti.
  wines=wines.map(x=>{
    if(x.id!==id) return x;
    if(diff>0){
      const pAcq=parseFloat(x.prezzoAcq)||0;
      const newLot={id:mov.id+"_lot",data:mov.data,fattura:"",fornitore:"",prezzoAcq:pAcq,iva:x.iva||22,qtyCaricata:diff,qtyRimanente:diff};
      return {...x,giacenza:newQty,lots:[...(x.lots||[]),newLot]};
    } else {
      let rem=Math.abs(diff);
      const updLots=(x.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c};});
      return {...x,giacenza:newQty,lots:updLots};
    }
  });
  scheduleSave();
  // PATCH: flush immediato — rettifica giacenza è irreversibile
  clearTimeout(saveTimer); _flushSave();
  document.getElementById("rett-backdrop")?.remove();
  notify(`⚖️ Rettifica registrata: ${w.nome} → ${newQty} bt (${diff>0?"+":""}${diff})`);
  render();
}

function _hideTopbarActions(){ _selectedWineId=null; }

// ─── COLUMN RESIZE ───────────────────────────────────────────────────────────
const _colWidths = {};
function initColResize(){
  document.querySelectorAll(".inv-table th").forEach(function(th){
    // Restore saved width
    const key = th.textContent.trim().slice(0,20);
    if(_colWidths[key]) th.style.width = _colWidths[key];
    // Remove old handle if present
    const old = th.querySelector(".col-rz");
    if(old) old.remove();
    // Add resize handle
    const rz = document.createElement("span");
    rz.className = "col-rz";
    th.appendChild(rz);
    let startX, startW;
    rz.addEventListener("mousedown", function(e){
      e.preventDefault(); e.stopPropagation();
      rz.classList.add("dragging");
      startX = e.clientX;
      startW = th.offsetWidth;
      function onMove(e){
        const w = Math.max(40, startW + e.clientX - startX);
        th.style.width = w + "px";
        _colWidths[key] = w + "px";
      }
      function onUp(){
        rz.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// ─── INLINE EDIT (doppio click su cella) ──────────────────────────────────────
function inlineEdit(evt, field, wineId, currentVal){
  evt.stopPropagation();
  const td = evt.currentTarget;
  if(td.querySelector(".inline-edit-input")) return; // già in edit
  const isNum = ["prezzoAcq","prezzoCarta"].includes(field);
  const orig = td.innerHTML;
  const inp = document.createElement("input");
  inp.className = "inline-edit-input form-input";
  inp.type = isNum ? "number" : "text";
  // FIX T-B7: prezzoCarta è sempre intero (coerente con saveWine e _migrateWines)
  inp.step = field==="prezzoCarta" ? "1" : (isNum ? "0.01" : undefined);
  inp.min = isNum ? "0" : undefined;
  inp.value = currentVal;
  inp.style.cssText = `width:100%;min-width:${isNum?80:120}px;font-size:12px;padding:4px 8px;font-family:inherit;text-align:${isNum?"right":"left"}`;
  td.innerHTML = "";
  td.appendChild(inp);
  inp.focus(); inp.select();
  const commit = async () => {
    const raw = inp.value.trim();
    let val = isNum ? (parseFloat(raw)||0) : raw;
    // FIX T-B7: arrotonda prezzoCarta a intero
    if(field==="prezzoCarta") val = Math.round(val);
    if(String(val) === String(currentVal)){ td.innerHTML = orig; return; }
    const idx = wines.findIndex(x=>x.id===wineId);
    if(idx === -1){ td.innerHTML = orig; return; }
    // Immutable update: sostituisce l'oggetto nell'array senza mutarlo direttamente
    // S10: traccia variazioni prezzoAcq/prezzoCarta nello storico prezzi
    const prevWine = wines[idx];
    const newAcq   = field==='prezzoAcq'   ? val : null;
    const newCarta = field==='prezzoCarta' ? val : null;
    let updWine = (newAcq!==null||newCarta!==null)
      ? _trackPriceChange(prevWine, newAcq, newCarta, 'inline_edit')
      : prevWine;
    wines[idx] = {...updWine, [field]: val};
    // B2: se si rinomina il vino, propaga il nuovo nome ai movimenti e fallate storici
    if(field === 'nome'){
      movements = movements.map(m => m.wineId===wineId ? {...m, wineName: val} : m);
      fallate   = fallate.map(f   => f.wineId===wineId ? {...f, wineName: val} : f);
    }
    scheduleSave();
    renderInventarioOnly();
    notify(`✏️ ${field} aggiornato`);
  };
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", e=>{
    if(e.key==="Enter"){ e.preventDefault(); inp.blur(); }
    if(e.key==="Escape"){ inp.removeEventListener("blur",commit); td.innerHTML=orig; }
  });
}
function getStats(){
  let giacenzaTot=0,valoreTot=0,valoreCarta=0,margineLordoTot=0,scoreBasse=0,esaurite=0;
  for(const w of wines){
    const g=parseInt(w.giacenza)||0, carta=parseFloat(w.prezzoCarta)||0;
    const vc=calcValore(w), costoMedioIva=calcCostoIvaBottiglia(w);
    giacenzaTot+=g; valoreTot+=vc; valoreCarta+=carta*g;
    if(carta&&costoMedioIva) margineLordoTot+=(carta-costoMedioIva)*g;
    // M1: esaurite e scorte basse sono conteggi separati — giacenza 0 non è "scorta bassa"
    if(g===0) esaurite++; else if(g<=(_getSoglie(w.id).min)) scoreBasse++;
  }
  const refAttive=wines.filter(w=>(parseInt(w.giacenza)||0)>0).length;
  const refEsaurite=wines.filter(w=>(parseInt(w.giacenza)||0)===0).length;
  return {referenze:wines.length,refAttive,refEsaurite,giacenzaTot,valoreTot,valoreCarta,margineLordoTot,scoreBasse,esaurite,
    fallateTot:fallate.reduce((s,f)=>s+f.qty,0)};
}
function updateSidebar(){
  const s=getStats();
  document.getElementById("ss-ref").textContent=s.referenze;
  document.getElementById("ss-bot").textContent=s.giacenzaTot;
  document.getElementById("ss-costo").textContent=fmt(s.valoreTot);
  document.getElementById("ss-pot").textContent=fmt(s.valoreCarta);
}

// ─── MOBILE FLAG (declared here so render() can reference it) ─────────────────
var _mobActive = false;

// ─── RENDER DISPATCHER ────────────────────────────────────────────────────────
function render(){
  if(_mobActive){ _renderMobList(); _renderMobLog(); updateSidebar(); return; }
  updateSidebar();
  destroyCharts();
  const c=document.getElementById("content");
  if(section==="dashboard") c.innerHTML=renderPlancia();
  else if(section==="inventario") c.innerHTML=renderInventario();
  else if(section==="scarico-serata") c.innerHTML=renderScaricoSerataPage();
  else if(section==="report-serata"){ go("scarico-serata"); return; }
  else if(section==="movimenti"){movForm.data=today();fallForm.data=today();c.innerHTML=renderMovimenti();}
  else if(section==="fallate") c.innerHTML=renderFallate();
  else if(section==="ordini"){
    c.innerHTML=renderOrdini();
    _loadBozzeSb(); // carica bozze remote in background e aggiorna se ci sono
  }
  else if(section==="export") c.innerHTML=renderExport();
  else if(section==="impostazioni") c.innerHTML=renderImpostazioni();
  afterRender();
}

function _setInvScrollHeight(){
  // Nessun calcolo JS — lo scroll è della pagina, altezza automatica
}

function afterRender(){
  if(section==="dashboard") initPlanciaCharts();
  // Shortcut tooltip hints su bottoni topbar
  _applyShortcutTitles();
  // Auto-focus campo vino su Movimenti (evita clic manuale al cambio sezione)
  if(section==="movimenti"){
    requestAnimationFrame(()=>{
      const wineInput = document.getElementById('mov-wine-input');
      if(wineInput && !movForm.wineId) wineInput.focus();
    });
  }
  if(section==="inventario"){
    _setInvScrollHeight();
    initColResize();
    // Ripristina riga selezionata se ancora presente
    if(_selectedWineId){
      const row=document.querySelector(`.inv-table tr[data-wine-id="${_selectedWineId}"]`);
      if(row){ row.classList.add("row-selected"); _updateTopbarActions(_selectedWineId); }
      else { _selectedWineId=null; }
    }
  }
  // Ripristina stato pannello report inline se era aperto
  if(section==="scarico-serata" && _reportInlineOpen){
    const body=document.getElementById("report-inline-body");
    const arrow=document.getElementById("report-inline-arrow");
    if(body){ body.style.display="block"; body.innerHTML=_renderReportBody(reportSerataData); }
    if(arrow){ arrow.className="report-toggle-arrow open"; }
  }
}

// Aggiorna i title dei bottoni topbar con hint shortcut da tastiera
function _applyShortcutTitles(){
  const el = document.getElementById("btn-add-wine");
  if(el) el.title = "Aggiungi Vino  [N]";
}

// Funzione pura: filtra e ordina wines secondo i filtri/ordinamento correnti.
// Usata sia da renderInventario che da renderInventarioOnly (unica source of truth).
function _buildInventarioList(){
  const q=search.toLowerCase();
  const fvit=[...filterVitigni];
  let list=wines.filter(w=>{
    const mq=!q||[w.nome,w.produttore,w.distributore,w.regione,w.vitigni,w.annata,w.nazione].some(f=>(f||"").toLowerCase().includes(q));
    const mt=filterTipo==="tutti"||w.tipologia===filterTipo;
    const wVit=(w.vitigni||"").split(/[,;/&+]+/).map(v=>v.trim().toLowerCase());
    const mv=!fvit.length||fvit.every(g=>wVit.includes(g));
    const mf=filterFormato==="tutti"||(parseFloat(w.formato)||0.75)===parseFloat(filterFormato);
    const md=filterDistrib==="tutti"||(w.distributore||"")===filterDistrib;
    const mp=filterProduttore==="tutti"||(w.produttore||"")===filterProduttore;
    const mr=filterRegione==="tutti"||(w.regione||"")===filterRegione;
    const mn=filterNazione==="tutti"||(w.nazione||"")===filterNazione;
    const mg=filterGiacenza==="tutti"
      ||(filterGiacenza==="esaurito"&&(w.giacenza||0)===0)
      ||(filterGiacenza==="basso"&&(w.giacenza||0)>0&&(w.giacenza||0)<=(w.soglia||3))
      ||(filterGiacenza==="ok"&&(w.giacenza||0)>(w.soglia||3));
    return mq&&mt&&mv&&mf&&md&&mp&&mr&&mn&&mg;
  });
  const d=invSortDir;
  const tipoIdxMap=Object.fromEntries(TIPOLOGIE.map((t,i)=>[t,i]));
  const tipoIdx=t=>tipoIdxMap[t]??999;
  if(invSort==="nome") list.sort((a,b)=>d*a.nome.localeCompare(b.nome));
  else if(invSort==="produttore") list.sort((a,b)=>d*((a.produttore||"").localeCompare(b.produttore||"")||a.nome.localeCompare(b.nome)));
  else if(invSort==="regione") list.sort((a,b)=>d*((a.regione||"").localeCompare(b.regione||"")||a.nome.localeCompare(b.nome)));
  else if(invSort==="nazione") list.sort((a,b)=>d*((a.nazione||"").localeCompare(b.nazione||"")||a.nome.localeCompare(b.nome)));
  else if(invSort==="giacenza") list.sort((a,b)=>d*(b.giacenza-a.giacenza));
  else if(invSort==="prezzoAcq") list.sort((a,b)=>d*(b.prezzoAcq-a.prezzoAcq));
  else if(invSort==="prezzoCarta") list.sort((a,b)=>d*(b.prezzoCarta-a.prezzoCarta));
  else if(invSort==="distributore") list.sort((a,b)=>d*((a.distributore||"").localeCompare(b.distributore||"")||a.nome.localeCompare(b.nome)));
  else if(invSort==="annata") list.sort((a,b)=>d*((parseInt(a.annata)||0)-(parseInt(b.annata)||0)));
  else list.sort((a,b)=>d*(tipoIdx(a.tipologia)-tipoIdx(b.tipologia)||a.nome.localeCompare(b.nome)));
  return list;
}

function _resetInvFilters(){
  filterTipo="tutti"; filterVitigni.clear(); filterFormato="tutti";
  filterDistrib="tutti"; filterProduttore="tutti"; filterRegione="tutti";
  filterNazione="tutti"; filterGiacenza="tutti";
  renderInventarioOnly();
}
function _hasActiveFilters(){
  return filterTipo!=="tutti"||filterVitigni.size>0||filterFormato!=="tutti"
    ||filterDistrib!=="tutti"||filterProduttore!=="tutti"||filterRegione!=="tutti"
    ||filterNazione!=="tutti"||filterGiacenza!=="tutti";
}
// ─── MULTI-VITIGNO ───────────────────────────────────────────────────────────
function _toggleVitigno(v){
  const k=String(v).toLowerCase();
  if(filterVitigni.has(k)) filterVitigni.delete(k); else filterVitigni.add(k);
  renderInventarioOnly();
}
function _clearVitigni(){ filterVitigni.clear(); renderInventarioOnly(); }
// Stato attivo di un chip del popover — fonte unica usata sia in render sia in sync.
function _isChipActive(fkey, fval){
  switch(fkey){
    case "vitigno": return fval==="__all__" ? filterVitigni.size===0 : filterVitigni.has(fval);
    case "formato": return filterFormato===fval;
    case "distrib": return filterDistrib===fval;
    case "prod":    return filterProduttore===fval;
    case "regione": return filterRegione===fval;
    case "nazione": return filterNazione===fval;
    default: return false;
  }
}
function _applyChipStyle(btn, active){
  btn.style.borderColor = active ? "rgba(10,132,255,.5)"  : "var(--border2)";
  btn.style.background  = active ? "rgba(10,132,255,.16)" : "rgba(255,255,255,.04)";
  btn.style.color       = active ? "#0A84FF"              : "var(--txt3)";
  btn.style.fontWeight  = active ? "700" : "400";
}
function _toggleInvFilterPanel(){
  const panel = document.getElementById("inv-filter-panel");
  if(!panel) return;
  const isOpen = panel.classList.contains("inv-panel-open");
  if(isOpen){ _closeInvFilterPanel(); return; }

  // Posiziona il popover sotto il bottone "Filtri avanzati"
  const btn = document.getElementById("inv-filter-btn");
  const bar = document.getElementById("inv-filter-bar");
  if(btn){
    const btnRect = btn.getBoundingClientRect();
    const barRect = bar ? bar.getBoundingClientRect() : btnRect;
    // Posiziona a destra del bottone, sotto la barra — non a full-width
    const left = Math.min(btnRect.left, window.innerWidth - 340);
    panel.style.top = barRect.bottom + "px";
    panel.style.left = Math.max(8, left) + "px";
    panel.style.right = "auto";
    panel.style.width = "320px";
  }

  panel.style.display = "block";
  panel.classList.add("inv-panel-open");
  btn && (btn.dataset.open = "1");

  // Crea overlay leggero se non esiste
  let overlay = document.getElementById("inv-filter-overlay");
  if(!overlay){
    overlay = document.createElement("div");
    overlay.id = "inv-filter-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:299";
    overlay.addEventListener("click", ()=>_closeInvFilterPanel());
    document.body.appendChild(overlay);
  }
  overlay.style.display = "block";

  panel.style.opacity = "0"; panel.style.transform = "translateY(-4px) scale(.98)";
  requestAnimationFrame(()=>{
    panel.style.transition = "opacity .15s ease, transform .15s ease";
    panel.style.opacity = "1"; panel.style.transform = "translateY(0) scale(1)";
  });
}
function _closeInvFilterPanel(){
  const p = document.getElementById("inv-filter-panel");
  const overlay = document.getElementById("inv-filter-overlay");
  const btn = document.getElementById("inv-filter-btn");
  if(p){ p.style.opacity="0"; p.style.transform="translateY(-4px) scale(.98)";
    setTimeout(()=>{ if(p){ p.style.display="none"; p.classList.remove("inv-panel-open"); p.style.transition=""; p.style.opacity=""; p.style.transform=""; } }, 130); }
  if(overlay) overlay.style.display = "none";
  if(btn) delete btn.dataset.open;
}
document.addEventListener("click", function(e){
  const p = document.getElementById("inv-filter-panel");
  const btn = document.getElementById("inv-filter-btn");
  if(!p || !p.classList.contains("inv-panel-open")) return;
  if(p.contains(e.target) || (btn && btn.contains(e.target))) return;
  _closeInvFilterPanel();
});

// Aggiorna lo stato visivo dei bottoni filtro inline (segmented + tipo chips)
// senza ricostruire l'intera filter bar. Chiamata dal path chirurgico di renderInventarioOnly.
function _syncInvFilterBar(){
  // Segmented control giacenza
  document.querySelectorAll("#inv-filter-bar button[data-seg]").forEach(btn=>{
    const act = btn.dataset.seg === filterGiacenza;
    btn.style.background = act ? "var(--bg3)" : "transparent";
    btn.style.color = act ? "var(--txt1)" : "var(--txt4)";
    btn.style.fontWeight = act ? "700" : "500";
    btn.style.boxShadow = act ? "0 1px 4px rgba(0,0,0,.4)" : "none";
  });
  // Tipologia dropdown
  const tipoSel=document.getElementById("inv-tipo-select");
  if(tipoSel) tipoSel.value=filterTipo;
  const tipoWrap=document.getElementById("inv-tipo-wrap");
  if(tipoWrap){
    const act=filterTipo!=="tutti";
    tipoWrap.style.borderColor = act ? "rgba(10,132,255,.5)"  : "var(--border2)";
    tipoWrap.style.background   = act ? "rgba(10,132,255,.12)" : "var(--bg3)";
    tipoWrap.style.color        = act ? "#0A84FF"             : "var(--txt3)";
  }
  // Badge e colore bottone filtri avanzati
  const advBtn = document.getElementById("inv-filter-btn");
  if(advBtn){
    const advCount=(filterVitigni.size>0?1:0)+[filterFormato,filterDistrib,filterProduttore,filterRegione,filterNazione].filter(f=>f!=="tutti").length;
    const hasAdv = advCount>0;
    advBtn.style.borderColor = hasAdv ? "rgba(10,132,255,.5)"  : "var(--border2)";
    advBtn.style.background   = hasAdv ? "rgba(10,132,255,.12)" : "var(--bg3)";
    advBtn.style.color        = hasAdv ? "#0A84FF"             : "var(--txt3)";
    let badge = advBtn.querySelector("span[data-adv-badge]");
    if(hasAdv){
      if(!badge){ badge=document.createElement("span"); badge.dataset.advBadge="1"; badge.style.cssText="background:#0A84FF;color:#fff;border-radius:10px;padding:0 5px;font-size:8px;font-weight:700;line-height:15px;min-width:15px;text-align:center"; advBtn.appendChild(badge); }
      badge.textContent=advCount;
    } else { badge && badge.remove(); }
  }
  // Popover chip (single + multi vitigno) — ri-marca lo stato attivo senza full render
  document.querySelectorAll("#inv-filter-panel button[data-fkey]").forEach(btn=>{
    _applyChipStyle(btn, _isChipActive(btn.dataset.fkey, btn.dataset.fval));
  });
  // Sort pill — aggiorna label e freccia senza full render
  const sortSelect = document.getElementById("inv-sort-select");
  if(sortSelect) sortSelect.value = invSort;
  const sortDir = document.getElementById("inv-sort-dir");
  if(sortDir) sortDir.textContent = invSortDir===1?"↑":"↓";
  // Clear btn — crea/rimuove secondo stato filtri (il wrapper è sempre presente)
  const clearWrap = document.getElementById("inv-clear-wrap");
  if(clearWrap){
    const hasAny = _hasActiveFilters();
    if(hasAny && !clearWrap.querySelector('[data-clear-btn]')){
      clearWrap.innerHTML = `<button data-clear-btn="1" onclick="_resetInvFilters()" title="Cancella tutti i filtri" style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:8px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.07);color:#FF453A;font-size:10px;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap;transition:all .15s ease">✕</button>`;
    } else if(!hasAny){
      clearWrap.innerHTML = '';
    }
  }
}

let _searchDebounce=null;
function renderInventarioOnly(){
  clearTimeout(_searchDebounce);
  _searchDebounce=setTimeout(()=>{
    updateSidebar();

    // Prova aggiornamento chirurgico: se la tabella inventario è già nel DOM
    // aggiorna solo <tbody> evitando di ricostruire KPI, filtri, header.
    const tbody=document.querySelector(".inv-table tbody");
    const invSearch=document.getElementById("inv-search");
    if(tbody && invSearch){
      // Preserva scroll e cursore
      const sy=window.scrollY;
      const pos=invSearch.selectionStart;

      // Ricalcola lista filtrata/ordinata
      const list=_buildInventarioList();
      const tipoCountMap2=Object.fromEntries(TIPOLOGIE.map(t=>[t, list.filter(x=>x.tipologia===t).length]));

      // Aggiorna contatore referenze
      const countEl=document.getElementById("inv-count");
      if(countEl) countEl.innerHTML=`${list.length}<span style="color:var(--txt5);font-weight:400"> / ${wines.length}</span>`;

      // Genera solo le righe <tbody>
      if(list.length===0){
        tbody.innerHTML=`<tr><td colspan="13" style="text-align:center;padding:40px;color:var(--txt4)">Nessun vino trovato</td></tr>`;
      } else {
        tbody.innerHTML=list.map((w,i_)=>{
          const prevTipo_=i_>0?list[i_-1].tipologia:"";
          const groupHdr_=(invSort==="tipologia"&&filterTipo==="tutti"&&w.tipologia!==prevTipo_)?
            `<tr style="background:var(--bg)"><td colspan="13" style="padding:8px 16px 5px;border-top:2px solid rgba(255,159,10,.25);border-bottom:1px solid rgba(255,159,10,.12)"><span style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--amber);font-weight:700">${h(w.tipologia)}</span>&emsp;<span style="font-size:9px;color:var(--txt4)">${tipoCountMap2[w.tipologia]||0} etich.</span></td></tr>`:"";
          return groupHdr_+_renderWineRow(w);
        }).join("");
      }

      // B6: aggiorna _selAllIds con la lista filtrata corrente
      if(selMode==='wines') _selAllIds = list.map(w=>w.id);

      // Sincronizza stato visivo bottoni filtro inline (chip tipo, segmented, badge)
      _syncInvFilterBar();

      // Ripristina selezione, resize handles, scroll e focus
      if(_selectedWineId){
        const row=tbody.querySelector(`tr[data-wine-id="${_selectedWineId}"]`);
        if(row){row.classList.add("row-selected");_updateTopbarActions(_selectedWineId);}
        else{_selectedWineId=null;}
      }
      _updateBulkBar();
      _setInvScrollHeight();
      initColResize();
      window.scrollTo(0,sy);
      try{invSearch.focus();if(pos!==null)invSearch.setSelectionRange(pos,pos);}catch{}
      return;
    }

    // Fallback: re-render completo se la tabella non è ancora nel DOM
    // (es. primo caricamento dopo go("inventario"))
    const c=document.getElementById("content");
    const sy=window.scrollY;
    c.innerHTML=renderInventario();
    window.scrollTo(0,sy);
    afterRender();
    const newEl=document.getElementById("inv-search");
    if(newEl){newEl.focus();}
  },120);
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function renderPlancia(){
  const s=getStats();
  const wineMap=Object.fromEntries(wines.map(w=>[w.id,w]));
  const regioni=[...new Set(wines.map(w=>w.regione).filter(Boolean))].sort();
  const tipoList=[...new Set(wines.map(w=>w.tipologia).filter(Boolean))].sort();

  // ── FLOW: vendite filtrate per regione/tipologia ──
  const vendFilt=movements.filter(m=>m.tipo==="scarico").map(m=>({...m,wine:wineMap[m.wineId]||null}))
    .filter(m=>m.wine&&(!analyticsRegione||m.wine.regione===analyticsRegione)&&(!analyticsTipo||m.wine.tipologia===analyticsTipo));
  const totQty=vendFilt.reduce((a,m)=>a+m.qty,0);
  const totRicavo=vendFilt.reduce((a,m)=>a+calcRicavoMovimento(m,m.wine),0);
  const totCosto=vendFilt.reduce((a,m)=>a+calcCostoMovimento(m,m.wine),0);
  const totMargine=totRicavo-totCosto;

  // Trend ultimi 12 mesi (rolling): ricavo (barre) + margine (linea, asse dx)
  const now=new Date(), monthMap={};
  for(let i=11;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;monthMap[key]={key,label:d.toLocaleString("it-IT",{month:"short",year:"2-digit"}),ricavo:0,costo:0,vendute:0};}
  const wineMarginMap={};
  vendFilt.forEach(m=>{
    const key=(m.data||"").slice(0,7);
    if(monthMap[key]){monthMap[key].ricavo+=calcRicavoMovimento(m,m.wine);monthMap[key].costo+=calcCostoMovimento(m,m.wine);monthMap[key].vendute+=m.qty;}
    const mb=calcRicavoMovimento(m,m.wine)-calcCostoMovimento(m,m.wine);
    if(!wineMarginMap[m.wineId]) wineMarginMap[m.wineId]={name:m.wine.nome,margine:0,qty:0};
    wineMarginMap[m.wineId].margine+=mb; wineMarginMap[m.wineId].qty+=m.qty;
  });
  const trendData=Object.values(monthMap).map(d=>({...d,margine:d.ricavo-d.costo}));
  const topMargin=Object.values(wineMarginMap).sort((a,b)=>b.margine-a.margine).slice(0,10);

  // Best sellers Top 5 per bottiglie
  const bySales={};
  vendFilt.forEach(m=>{if(!bySales[m.wineId])bySales[m.wineId]={wineName:m.wineName,produttore:m.produttore,qty:0,ricavo:0,costo:0};bySales[m.wineId].qty+=m.qty;bySales[m.wineId].ricavo+=calcRicavoMovimento(m,m.wine);bySales[m.wineId].costo+=calcCostoMovimento(m,m.wine);});
  const bestSellers=Object.values(bySales).sort((a,b)=>b.qty-a.qty).slice(0,5);
  const maxQty=bestSellers[0]?.qty||1;

  // ── STOCK: giacenza per tipologia (snapshot, non filtrato) ──
  const _giacByTipo=wines.reduce((acc,w)=>{if(w.giacenza>0)acc[w.tipologia]=(acc[w.tipologia]||0)+w.giacenza;return acc;},{});
  const tipoPie=TIPOLOGIE.filter(t=>_giacByTipo[t]>0).map(t=>({name:t,value:_giacByTipo[t]}));

  // ── ACQUISTI ──
  const carichi=movements.filter(m=>m.tipo==="carico");
  function getAcquistiPerPeriodo(periodo){
    const buckets={};
    carichi.forEach(m=>{
      const w=wineMap[m.wineId];
      const p=parseFloat(m.prezzoAcqLotto)||parseFloat(w?.prezzoAcq)||0;
      const iva=(parseInt(w?.iva)||22)/100;
      const data=m.data||""; if(!data) return;
      let key;
      if(periodo==="giorno") key=data;
      else if(periodo==="settimana"){const d=new Date(data);const jan4=new Date(d.getFullYear(),0,4);const w1=new Date(jan4);w1.setDate(jan4.getDate()-((jan4.getDay()+6)%7));const wn=Math.floor((d-w1)/(7*86400000))+1;key=`${d.getFullYear()}-S${String(wn).padStart(2,'0')}`;}
      else key=data.slice(0,7);
      if(!buckets[key]) buckets[key]={key,qty:0,costoNetto:0,costoConIva:0};
      buckets[key].qty+=m.qty; buckets[key].costoNetto+=p*m.qty; buckets[key].costoConIva+=p*(1+iva)*m.qty;
    });
    return Object.values(buckets).sort((a,b)=>a.key.localeCompare(b.key));
  }
  const acquistiData=getAcquistiPerPeriodo(analyticsAcquistiPeriodo);
  const periodoLabels={giorno:"Giorno",settimana:"Settimana",mese:"Mese"};

  // ── ordini aperti (widget) ──
  const ordiniOpen=orders.filter(o=>o.stato==="attesa"||o.stato==="confermato_pendente");
  const ordiniPending=orders.filter(o=>o.stato==="confermato_pendente");
  const ordiniValTot=ordiniOpen.reduce((acc,o)=>(o.referenze||[]).reduce((x,r)=>x+(parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100)*(parseInt(r.qty)||0),acc),0);
  const ordiniQtyTot=ordiniOpen.reduce((acc,o)=>(o.referenze||[]).reduce((x,r)=>x+(parseInt(r.qty)||0),acc),0);

  // ═══════════════ HTML ═══════════════
  const _kpiCard=k=>`<div class="kpi-card"><div class="kpi-label">${k.label}</div><div class="kpi-val ${k.cls}">${k.value}</div><div class="kpi-sub">${k.sub}</div></div>`;

  // KPI STATO cantina (snapshot)
  const kpiStato1=[
    {label:"Ref. Attive",value:s.refAttive,sub:`su ${s.referenze} totali`,cls:"c-amber"},
    {label:"Ref. Terminate",value:s.refEsaurite,sub:"giacenza esaurita",cls:"c-red"},
    {label:"Giacenza",value:s.giacenzaTot,sub:"bottiglie totali",cls:"c-amber3"},
  ];
  const kpiStato2=[
    {label:"Valore al Costo",value:fmt(s.valoreTot),sub:"costo acquisto × giacenza (escl. IVA)",cls:"c-orange"},
    {label:"Valore Potenziale",value:fmt(s.valoreCarta),sub:"prezzo carta × giacenza",cls:"c-green"},
    {label:"Margine Lordo",value:fmt(s.margineLordoTot),sub:"potenziale vendita",cls:"c-blue"},
  ];
  let html=`<div style="font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:var(--txt4);margin-bottom:8px">Stato Cantina</div>
    <div class="kpi-grid g3" style="margin-bottom:12px">${kpiStato1.map(_kpiCard).join("")}</div>
    <div class="kpi-grid g3" style="margin-bottom:20px">${kpiStato2.map(_kpiCard).join("")}</div>`;

  // widget ordini
  const owColor=ordiniOpen.length>0?"rgba(255,159,10,.15)":"rgba(20,83,45,.2)";
  const owBorder=ordiniOpen.length>0?"rgba(180,83,9,.5)":"rgba(21,128,61,.4)";
  html+=`<div style="background:${owColor};border:1px solid ${owBorder};padding:14px 20px;margin-bottom:24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="font-size:1.6rem">${ordiniOpen.length>0?"📦":"✅"}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt3);margin-bottom:4px">Ordini Fornitore Aperti</div>
      ${ordiniOpen.length===0
        ? `<div style="font-family:'Montserrat',sans-serif;font-weight:300;font-size:1.15rem;color:#30D158">Nessun ordine in sospeso</div>`
        : `<div style="display:flex;align-items:baseline;gap:16px;flex-wrap:wrap">
            <div style="font-family:'Montserrat',sans-serif;font-weight:300;font-size:1.5rem;color:var(--amber)">${ordiniOpen.length} <span style="font-size:.85rem;color:var(--txt3)">ordini</span></div>
            <div style="font-size:11px;color:var(--txt2)">${ordiniQtyTot} bottiglie · <span style="color:var(--amber)">${fmt(ordiniValTot)}</span> stimato IVA incl.</div>
            ${ordiniPending.length>0?`<div style="font-size:10px;padding:2px 8px;background:#16a34a22;border:1px solid #16a34a55;color:#30D158">${ordiniPending.length} ricevut${ordiniPending.length===1?"o":"i"}, da caricare</div>`:""}
          </div>`}
    </div>
    <button class="btn-outline btn-sm" onclick="go('ordini')" style="${ordiniOpen.length>0?"border-color:var(--amber3);color:var(--amber)":"border-color:rgba(21,128,61,.5);color:#30D158"}">${ordiniOpen.length>0?"Vai agli ordini →":"Crea ordine →"}</button>
  </div>`;

  // Filtri (agiscono sulla zona performance/andamento)
  html+=`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
    <span style="font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:var(--txt4)">Performance</span>
    <select class="form-select" style="width:auto" onchange="analyticsRegione=this.value;render()">
      <option value="">Tutte le regioni</option>
      ${regioni.map(r=>`<option value="${r}" ${analyticsRegione===r?"selected":""}>${h(r)}</option>`).join("")}
    </select>
    <select class="form-select" style="width:auto" onchange="analyticsTipo=this.value;render()">
      <option value="">Tutte le tipologie</option>
      ${tipoList.map(t=>`<option value="${t}" ${analyticsTipo===t?"selected":""}>${h(t)}</option>`).join("")}
    </select>
    ${(analyticsRegione||analyticsTipo)?`<button class="btn-outline btn-sm" onclick="analyticsRegione='';analyticsTipo='';render()">✕ Reset</button>`:""}
    <span style="margin-left:auto;font-size:10px;color:var(--txt4)">${totQty} bottiglie vendute</span>
  </div>`;

  // KPI PERFORMANCE
  html+=`<div class="kpi-grid g4" style="margin-bottom:20px">
    ${[{label:"Bottiglie Vendute",v:totQty,cls:"c-amber",sub:"scarichi totali"},{label:"Costo Venduto",v:fmt(totCosto),cls:"c-red",sub:"costo+IVA"},{label:"Ricavo Totale",v:fmt(totRicavo),cls:"c-green",sub:"a prezzo carta"},{label:"Margine Realizzato",v:fmt(totMargine),cls:totMargine>=0?"c-blue":"c-red",sub:totRicavo?`${fmtN(totMargine/totRicavo*100,1)}% del ricavo`:"—"}].map(k=>`<div class="kpi-card"><div class="kpi-label">${k.label}</div><div class="kpi-val ${k.cls}">${k.v}</div><div class="kpi-sub">${k.sub}</div></div>`).join("")}
  </div>`;

  // ── ANDAMENTO: Trend | Storico Acquisti ──
  html+=`<div class="kpi-grid g2" style="margin-bottom:20px">
    <div class="card">
      <div class="section-label"><span>📈 Trend Mensile · Ricavo & Margine</span></div>
      <div class="chart-container" style="height:240px"><canvas id="ch-trend"></canvas></div>
    </div>
    <div class="card" style="padding:0">
      <div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:6px"><span style="color:var(--amber3)">📦</span><span style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt2)">Acquisti per ${periodoLabels[analyticsAcquistiPeriodo]}</span></div>
        <div style="display:flex;gap:4px">${["giorno","settimana","mese"].map(p=>`<button class="${analyticsAcquistiPeriodo===p?"btn-primary btn-sm":"btn-outline btn-sm"}" onclick="analyticsAcquistiPeriodo='${p}';render()">${periodoLabels[p]}</button>`).join("")}</div>
      </div>
      ${acquistiData.length===0?`<div style="padding:32px;text-align:center;color:var(--txt4);font-size:11px">Nessun carico registrato</div>`:`<div style="padding:20px"><div class="chart-container" style="height:200px"><canvas id="chart-acquisti"></canvas></div></div>`}
    </div>
  </div>`;

  // ── Top 10 Margine | Giacenza per Tipologia ──
  html+=`<div class="kpi-grid g2" style="margin-bottom:20px">
    <div class="card">
      <div class="section-label"><span>💰 Top 10 per Margine Realizzato</span></div>
      ${topMargin.length===0?`<div style="text-align:center;padding:24px;color:var(--txt4);font-size:11px">Nessuna vendita registrata</div>`:`<div class="chart-container" style="height:300px"><canvas id="ch-topmargin"></canvas></div>`}
    </div>
    <div class="card">
      <div class="section-label"><span>🎯 Giacenza per Tipologia</span></div>
      ${tipoPie.length===0?`<div style="text-align:center;padding:24px;color:var(--txt4);font-size:11px">Nessun dato</div>`:`
      <div style="display:flex;align-items:center;gap:16px">
        <div style="width:52%;min-width:130px;height:220px;position:relative"><canvas id="ch-pie"></canvas></div>
        <div class="pie-legend" style="flex:1">${tipoPie.map((d,i)=>`<div class="pie-row"><div style="display:flex;align-items:center;gap:6px"><div class="pie-dot" style="background:${PIE_COLORS[i%PIE_COLORS.length]}"></div><span style="color:var(--txt2);text-transform:uppercase">${h(d.name)}</span></div><span style="color:var(--amber)">${d.value} bt</span></div>`).join("")}</div>
      </div>`}
    </div>
  </div>`;

  // ── Best Sellers Top 5 (striscia) ──
  html+=`<div class="card" style="padding:0;margin-bottom:12px">
    <div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px"><span style="color:var(--amber3)">🏆</span><span style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt2)">Best Sellers — Top 5 per Bottiglie</span></div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
      ${bestSellers.length===0?`<div style="text-align:center;padding:24px;color:var(--txt4);font-size:11px">Nessuna vendita registrata</div>`:
      bestSellers.map((b,i)=>{const marg=b.ricavo-b.costo;const mp=b.ricavo?(marg/b.ricavo*100):0;return `<div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <span style="font-size:10px;color:var(--txt4);width:16px">#${i+1}</span>
          <div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${h(b.wineName)}</div><div style="color:var(--txt4);font-size:10px">${h(b.produttore)}</div></div>
          <div style="text-align:right"><div style="color:var(--amber);font-family:'Montserrat',sans-serif;font-size:1rem">${b.qty} bt</div><div style="color:${mp>=0?"#30D158":"#FF453A"};font-size:10px">${fmtN(mp,1)}% marg.</div></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding-left:26px">
          <div class="mini-bar"><div class="mini-bar-fill" style="width:${Math.min(100,(b.qty/maxQty)*100)}%"></div></div>
          <span style="font-size:10px;color:#30D158;width:72px;text-align:right">${fmt(marg)}</span>
        </div>
      </div>`}).join("")}
    </div>
  </div>`;

  window._plTrend=trendData;
  window._plTopMargin=topMargin;
  window._plPie=tipoPie;
  window._plAcquisti={labels:acquistiData.map(d=>d.key),qty:acquistiData.map(d=>d.qty),spesa:acquistiData.map(d=>Math.round(d.costoConIva*100)/100)};
  return html;
}

function initPlanciaCharts(){
  const _eur=v=>v>=1000?`€${(v/1000).toFixed(0)}k`:`€${v}`;
  // Trend combo: barre ricavo (sx) + linea margine (dx)
  const td=window._plTrend||[];
  const e1=document.getElementById("ch-trend");
  if(e1&&td.length){
    activeCharts.trend=new Chart(e1,{data:{labels:td.map(d=>d.label),datasets:[
      {type:"bar",label:"Ricavo",data:td.map(d=>d.ricavo),backgroundColor:"rgba(48,209,88,.45)",borderColor:"rgba(48,209,88,.9)",borderWidth:1,yAxisID:"y",order:2},
      {type:"line",label:"Margine",data:td.map(d=>d.margine),borderColor:"#3b82f6",backgroundColor:"rgba(59,130,246,.12)",borderWidth:2,pointRadius:3,pointBackgroundColor:"#3b82f6",tension:.35,yAxisID:"y1",order:1}
    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#8E8E93",font:{family:"Montserrat",size:10}}},tooltip:{backgroundColor:"rgba(28,25,23,.95)",titleColor:"var(--amber)",bodyColor:"#e7e5e4",borderColor:"rgba(68,64,60,.6)",borderWidth:1,callbacks:{label:c=>` ${c.dataset.label}: €${new Intl.NumberFormat("it-IT",{maximumFractionDigits:0}).format(c.raw)}`}}},scales:{x:{ticks:{color:"#636366",font:{family:"Montserrat",size:9}},grid:{color:"rgba(58,58,60,.4)"}},y:{position:"left",ticks:{color:"#30D158",font:{family:"Montserrat",size:9},callback:_eur},grid:{color:"rgba(58,58,60,.4)"},title:{display:true,text:"Ricavo",color:"#30D158",font:{size:9}}},y1:{position:"right",ticks:{color:"#3b82f6",font:{family:"Montserrat",size:9},callback:_eur},grid:{drawOnChartArea:false},title:{display:true,text:"Margine",color:"#3b82f6",font:{size:9}}}}}});
  }
  // Top 10 margine (bar orizzontale)
  const tm=window._plTopMargin||[];
  const e2=document.getElementById("ch-topmargin");
  if(e2&&tm.length){
    activeCharts.topmargin=new Chart(e2,{type:"bar",data:{labels:tm.map(d=>d.name.length>24?d.name.slice(0,22)+"…":d.name),datasets:[{label:"Margine €",data:tm.map(d=>d.margine),backgroundColor:"#FF9F0A",borderColor:"#CC7000",borderWidth:1}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` €${new Intl.NumberFormat("it-IT",{minimumFractionDigits:2}).format(c.raw)}`}}},scales:{x:{ticks:{color:"#636366",font:{family:"Montserrat",size:9},callback:v=>`€${(v/1000).toFixed(1)}k`},grid:{color:"#3A3A3C"}},y:{ticks:{color:"#8E8E93",font:{family:"Montserrat",size:9}},grid:{display:false}}}}});
  }
  // Doughnut giacenza per tipologia
  const pie=window._plPie||[];
  const e3=document.getElementById("ch-pie");
  if(e3&&pie.length){
    activeCharts.pie=new Chart(e3,{type:"doughnut",data:{labels:pie.map(d=>d.name),datasets:[{data:pie.map(d=>d.value),backgroundColor:PIE_COLORS.slice(0,pie.length),borderWidth:1,borderColor:"#000"}]},options:{responsive:true,maintainAspectRatio:false,cutout:"55%",plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.raw} bt`}}}}});
  }
  // Storico acquisti (barre bt + linea spesa)
  const d=window._plAcquisti;
  if(d&&d.labels&&d.labels.length){
    const el=document.getElementById("chart-acquisti");
    if(el) activeCharts.acquisti=new Chart(el,{data:{labels:d.labels,datasets:[
      {type:"bar",label:"Bottiglie acquistate",data:d.qty,backgroundColor:"rgba(245,158,11,0.55)",borderColor:"rgba(245,158,11,0.9)",borderWidth:1,yAxisID:"yQty",order:2},
      {type:"line",label:"Spesa (IVA incl.)",data:d.spesa,borderColor:"#30D158",backgroundColor:"rgba(74,222,128,0.10)",borderWidth:2,pointRadius:4,pointBackgroundColor:"#30D158",tension:.35,fill:true,yAxisID:"ySpesa",order:1}
    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#8E8E93",font:{family:"Montserrat",size:10}}},tooltip:{backgroundColor:"rgba(28,25,23,.95)",titleColor:"var(--amber)",bodyColor:"#e7e5e4",borderColor:"rgba(68,64,60,.6)",borderWidth:1,callbacks:{label:c=>c.datasetIndex===0?` ${c.raw} bt`:` €${new Intl.NumberFormat("it-IT",{minimumFractionDigits:2}).format(c.raw)}`}}},scales:{x:{ticks:{color:"#636366",font:{family:"Montserrat",size:9},maxRotation:45},grid:{color:"rgba(41,37,36,.4)"}},yQty:{position:"left",ticks:{color:"var(--amber)",font:{family:"Montserrat",size:9}},grid:{color:"rgba(41,37,36,.4)"},title:{display:true,text:"Bottiglie",color:"var(--amber)",font:{size:9}}},ySpesa:{position:"right",ticks:{color:"#30D158",font:{family:"Montserrat",size:9},callback:v=>"€"+new Intl.NumberFormat("it-IT",{maximumFractionDigits:0}).format(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Spesa €",color:"#30D158",font:{size:9}}}}}});
  }
}

// ─── _renderWineRow ───────────────────────────────────────────────────────────
// Funzione pura: genera l'HTML di una <tr> dell'inventario.
// Usata sia da renderInventario (render completo) che da renderInventarioOnly
// (aggiornamento chirurgico del solo <tbody>), eliminando la duplicazione.
function _renderWineRow(w){
  const mp=calcMarginePerc(w);
  const sg=_getSoglie(w.id), isAlert=w.giacenza<=sg.min, isEmpty=w.giacenza===0, isRiordino=!isEmpty&&!isAlert&&w.giacenza<=sg.riordino;
  const mpColor=mp===null?'var(--txt4)':mp>=50?'#30D158':mp>=30?'var(--amber)':'#FF453A';
  const gColor=isEmpty?'#FF453A':isAlert?'#fb923c':isRiordino?'#fbbf24':'var(--amber)';
  const rowClass=isEmpty?'alert-empty':isAlert?'alert-low':isRiordino?'alert-riordino':'';
  const cbHtml=selMode==='wines'?`<td class="cb-col"><input type="checkbox" class="cb-sel" data-id="${w.id}" onchange="toggleSel('${w.id}');_updateBulkBar()"></td>`:'';
  const fmtBadge=(parseFloat(w.formato)||0.75)>0.75?` <span style="font-size:8px;font-weight:600;padding:1px 5px;border:1px solid rgba(0,122,255,.35);color:#60a5fa;background:rgba(0,122,255,.1);border-radius:3px;white-space:nowrap">${w.formato}L</span>`:'';
  const zonaHtml=w.zona?`<div class="col-zona" style="font-size:9px;color:var(--txt4)">${h(w.zona)}</div>`:'';
  const annataHtml=w.annata||`<span style="color:var(--txt4)">N.V.</span>`;
  const regioneHtml=(w.regione?`<span>${h(w.regione)}</span>`:'')+(w.nazione?`${w.regione?' · ':''}<span style="color:var(--amber3);font-weight:600">${h(w.nazione)}</span>`:'');
  const nomeEsc=h(w.nome).replace(/'/g,"\\'");
  return `<tr class="${rowClass}" data-sel-id="${w.id}" data-wine-id="${w.id}" style="cursor:pointer">
    ${cbHtml}
    <td class="col-fornitore" style="color:var(--txt3);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px">${h(w.distributore||'—')}</td>
    <td style="color:var(--txt2);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(w.produttore)}</td>
    <td><div style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${h(w.nome)}${fmtBadge}</div>${zonaHtml}</td>
    <td class="col-annata"><span style="color:var(--amber);font-family:'Montserrat',sans-serif;white-space:nowrap;font-size:11px">${annataHtml}</span></td>
    <td class="col-vitigni" style="color:var(--txt3);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px">${h(w.vitigni||'—')}</td>
    <td>${badge(w.tipologia)}</td>
    <td class="col-regione" style="color:var(--txt3);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px">${regioneHtml}</td>
    <td class="r" style="border-left:1px solid var(--border);white-space:nowrap">${fmt(w.prezzoAcq)}</td>
    <td class="r col-ivaincl" style="color:var(--txt3);white-space:nowrap">${fmtRound(calcCostoIvaBottiglia(w))}</td>
    <td class="r col-pcarta" style="white-space:nowrap;${!w.prezzoCarta?'color:var(--txt4)':''}">${w.prezzoCarta?fmt(w.prezzoCarta):'—'}</td>
    <td class="r col-margperc"><span style="color:${mpColor}">${mp===null?'—':`${fmtN(mp,1)}%`}</span></td>
    <td class="c" style="border-left:1px solid rgba(255,159,10,.12);background:rgba(255,159,10,.04);position:relative">
      <div style="display:flex;flex-direction:column;align-items:center;gap:1px">
        <div style="color:${gColor}" class="giacenza-big">${w.giacenza}</div>
        ${isEmpty?'<div style="font-size:7px;color:#dc2626;text-transform:uppercase;letter-spacing:.08em">esaurito</div>':''}
        ${!isEmpty&&isAlert?'<div style="font-size:7px;color:#ea580c;text-transform:uppercase;letter-spacing:.08em">scorta bassa</div>':''}
        ${isRiordino?'<div style="font-size:7px;color:#d97706;text-transform:uppercase;letter-spacing:.08em">riordina</div>':''}
        <button onclick="event.stopPropagation();_toggleSogliaPop('${w.id}',this)" style="font-size:9px;margin-top:2px;padding:1px 5px;border:1px solid rgba(68,64,60,.5);background:none;color:var(--txt4);cursor:pointer;font-family:inherit;line-height:1.4" title="Imposta soglie alert">
          <span style="color:#FF453A">${sg.min}</span>·<span style="color:#fbbf24">${sg.riordino}</span>
        </button>
      </div>
    </td>
  </tr>`;
}

// ─── INVENTARIO ───────────────────────────────────────────────────────────────
function renderInventario(){
  const s=getStats();
  const list=_buildInventarioList();
  // ── sort già applicato in _buildInventarioList ──
  let tfG=0;
  list.forEach(w=>{tfG+=w.giacenza});

  let html=`<div style="display:flex;gap:1px;margin-bottom:14px;border-radius:var(--radius);overflow:hidden;border:1px solid var(--border)">
    ${[
      {label:"Referenze",     v:s.referenze,          sub:"vini in lista",    cls:"c-amber"},
      {label:"Giacenza",      v:s.giacenzaTot,        sub:"bottiglie",        cls:"c-amber3"},
      {label:"Scorte Basse",  v:s.scoreBasse,         sub:`+${s.esaurite} esaurite`, cls:(s.scoreBasse>0||s.esaurite>0)?"c-red":"c-green"},
      {label:"Valore Costo",  v:fmt(s.valoreTot),     sub:"excl. IVA",        cls:"c-amber"},
      {label:"Potenziale",    v:fmt(s.valoreCarta),   sub:"valore carta",     cls:"c-green"},
      {label:"Margine",       v:fmt(s.margineLordoTot),sub:"lordo potenz.",   cls:"c-blue"},
    ].map(k=>`<div style="flex:1;min-width:0;padding:10px 14px;background:var(--bg2)">
      <div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt4);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${k.label}</div>
      <div style="font-size:15px;font-weight:700;font-family:'Montserrat',sans-serif;margin:3px 0 1px" class="${k.cls}">${k.v}</div>
      <div style="font-size:9px;color:var(--txt5)">${k.sub}</div>
    </div>`).join("")}
  </div>`;

  const tipiPresenti=new Set(wines.map(w=>w.tipologia));
  const activeTipi=TIPOLOGIE.filter(t=>tipiPresenti.has(t));
  const tipoCountMap=Object.fromEntries(TIPOLOGIE.map(t=>[t, list.filter(x=>x.tipologia===t).length]));
  const activeVitigni=[...new Set(wines.flatMap(w=>(w.vitigni||"").split(/[,;/&+]+/).map(v=>v.trim())).filter(v=>v.length>1&&v.length<30))].sort();
  const activeFormati=[...new Set(wines.map(w=>parseFloat(w.formato)||0.75).filter(f=>f>0.75))].sort((a,b)=>a-b);
  const activeDistrib=[...new Set(wines.map(w=>w.distributore||"").filter(Boolean))].sort();
  const activeProd=[...new Set(wines.map(w=>w.produttore||"").filter(Boolean))].sort();
  const activeRegioni=[...new Set(wines.map(w=>w.regione||"").filter(Boolean))].sort();
  const activeNazioni=[...new Set(wines.map(w=>w.nazione||"").filter(Boolean))].sort();

  const activeCount=(filterVitigni.size>0?1:0)+[filterTipo,filterFormato,filterDistrib,filterProduttore,filterRegione,filterNazione,filterGiacenza].filter(f=>f!=="tutti").length;
  // advCount: solo filtri nel popover avanzato (esclude Tipo e Giacenza che sono inline)
  const advCount=(filterVitigni.size>0?1:0)+[filterFormato,filterDistrib,filterProduttore,filterRegione,filterNazione].filter(f=>f!=="tutti").length;

  // Opzioni sort
  const sortOpts=[
    {v:"tipologia",label:"Tipologia"},{v:"nome",label:"Nome vino"},
    {v:"produttore",label:"Produttore"},{v:"annata",label:"Annata"},
    {v:"regione",label:"Regione"},{v:"nazione",label:"Nazione"},
    {v:"giacenza",label:"Giacenza"},{v:"prezzoAcq",label:"P. Acquisto"},
    {v:"prezzoCarta",label:"P. Carta"},{v:"distributore",label:"Fornitore"},
  ];
  const dirIcon=invSortDir===1?"↑":"↓";

  // ── Stile unificato controlli toolbar (look Apple, accent system-blue unico) ──
  const ctrlBase = "height:28px;display:inline-flex;align-items:center;gap:5px;border-radius:8px;padding:0 9px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;flex-shrink:0;box-sizing:border-box;transition:all .15s ease";
  const ctrlOn   = "border:1px solid rgba(10,132,255,.5);background:rgba(10,132,255,.12);color:#0A84FF";
  const ctrlOff  = "border:1px solid var(--border2);background:var(--bg3);color:var(--txt3)";

  const _setVarMap={formato:"filterFormato",distrib:"filterDistrib",prod:"filterProduttore",regione:"filterRegione",nazione:"filterNazione"};
  function _fSection({title, opts, fkey, multi}){
    const esc=v=>String(v).replace(/'/g,"\\'");
    return `<div>
      <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--txt4);font-weight:700;margin-bottom:6px">${title}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${opts.map(o=>{
          const isAll=o.v==="tutti";
          const fval = multi ? (isAll?"__all__":String(o.v).toLowerCase()) : String(o.v);
          const active=_isChipActive(fkey,fval);
          const click = multi
            ? (isAll?"_clearVitigni()":`_toggleVitigno('${esc(o.v)}')`)
            : `${_setVarMap[fkey]}='${esc(o.v)}';renderInventarioOnly()`;
          return `<button data-fkey="${fkey}" data-fval="${h(fval)}" onclick="${click}" style="padding:3px 10px;border-radius:20px;font-size:10px;cursor:pointer;border:1px solid ${active?'rgba(10,132,255,.5)':'var(--border2)'};background:${active?'rgba(10,132,255,.16)':'rgba(255,255,255,.04)'};color:${active?'#0A84FF':'var(--txt3)'};font-weight:${active?'700':'400'};white-space:nowrap;transition:all .12s ease">${h(o.label)}</button>`;
        }).join("")}
      </div>
    </div>`;
  }

  html+=`<div class="card" style="padding:0;position:relative">
    ${selMode==='wines'?renderBulkBar('wines', list.map(w=>w.id)):''}
    <div id="inv-filter-bar" style="position:sticky;top:${selMode==='wines'?'110px':'57px'};z-index:18;background:var(--bg2);border-bottom:1px solid var(--border)">

      <!-- SINGLE ROW: search · count · segmented · tipo chips · sort · filtri · multipla -->
      <div style="display:flex;align-items:center;gap:6px;padding:7px 12px;min-height:44px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch">

        <!-- Search -->
        <div class="search-wrap" style="flex-shrink:0;width:200px"><span class="search-icon">🔍</span><input id="inv-search" class="form-input" style="width:100%;padding-left:28px" placeholder="Cerca vino…  [/]" value="${h(search)}" oninput="search=this.value;renderInventarioOnly()"></div>

        <!-- Count -->
        <span id="inv-count" style="font-size:10px;color:var(--txt4);letter-spacing:.05em;white-space:nowrap;flex-shrink:0">${list.length}<span style="color:var(--txt5);font-weight:400"> / ${wines.length}</span></span>

        <!-- Separatore -->
        <div style="width:1px;height:18px;background:var(--border);flex-shrink:0"></div>

        <!-- Segmented giacenza -->
        <div style="display:inline-flex;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:8px;padding:2px;gap:1px;flex-shrink:0">
          ${[
            {v:"tutti",   label:"Tutti"},
            {v:"esaurito",label:"Esauriti"},
            {v:"basso",   label:"Basse"},
            {v:"ok",      label:"OK"},
          ].map(seg=>{
            const act = filterGiacenza===seg.v;
            return `<button data-seg="${seg.v}" onclick="filterGiacenza='${seg.v}';renderInventarioOnly()" style="padding:3px 9px;border-radius:6px;border:none;font-size:10px;font-weight:${act?'700':'500'};cursor:pointer;white-space:nowrap;transition:all .15s ease;${act?'background:var(--bg3);color:var(--txt1);box-shadow:0 1px 4px rgba(0,0,0,.4)':'background:transparent;color:var(--txt4)'}">${seg.label}</button>`;
          }).join('')}
        </div>

        <!-- Separatore -->
        <div style="width:1px;height:18px;background:var(--border);flex-shrink:0"></div>

        <!-- Tipologia dropdown -->
        <div id="inv-tipo-wrap" style="${ctrlBase};${filterTipo!=='tutti'?ctrlOn:ctrlOff};padding:0 6px 0 9px">
          <select id="inv-tipo-select" onchange="filterTipo=this.value;renderInventarioOnly()" style="background:transparent;border:none;outline:none;font-size:11px;font-weight:600;color:inherit;cursor:pointer;font-family:inherit;padding:0 2px">
            ${[{v:'tutti',label:'Tutte le tipologie'}, ...activeTipi.map(t=>({v:t,label:t}))].map(o=>`<option value="${h(o.v)}" ${filterTipo===o.v?'selected':''} style="background:var(--bg2);color:var(--txt1)">${h(o.label)}</option>`).join('')}
          </select>
        </div>

        <!-- Ordina: select + direzione -->
        <div style="${ctrlBase};${ctrlOff};gap:3px;padding:0 5px 0 8px">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="flex-shrink:0;color:currentColor;opacity:.8"><path d="M1 3h10M3 6h6M5 9h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <select id="inv-sort-select" onchange="invSort=this.value;renderInventarioOnly()" style="background:transparent;border:none;outline:none;font-size:11px;font-weight:600;color:inherit;cursor:pointer;padding:0 2px;font-family:inherit">
            ${sortOpts.map(o=>`<option value="${o.v}" ${invSort===o.v?'selected':''} style="background:var(--bg2);color:var(--txt1)">${h(o.label)}</option>`).join('')}
          </select>
          <button id="inv-sort-dir" onclick="invSortDir*=-1;renderInventarioOnly()" style="background:none;border:none;color:currentColor;font-size:12px;cursor:pointer;padding:0 2px;font-weight:700;line-height:1" title="Inverti direzione">${dirIcon}</button>
        </div>

        <!-- Filtri Avanzati -->
        <div style="position:relative;flex-shrink:0">
          <button id="inv-filter-btn" onclick="_toggleInvFilterPanel()" style="${ctrlBase};${advCount>0?ctrlOn:ctrlOff};letter-spacing:.02em">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="3" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="9" r="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 3h3.5M7.5 3H11M1 9h3.5M7.5 9H11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Filtri${advCount>0?` <span style="background:#0A84FF;color:#fff;border-radius:10px;padding:0 5px;font-size:8px;font-weight:700;line-height:15px;min-width:15px;text-align:center">${advCount}</span>`:''}
          </button>
        </div>

        <!-- Reset filtri (solo se attivi) -->
        <span id="inv-clear-wrap">${_hasActiveFilters()?`<button data-clear-btn="1" onclick="_resetInvFilters()" title="Cancella tutti i filtri" style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:8px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.07);color:#FF453A;font-size:10px;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap;transition:all .15s ease">✕</button>`:""}</span>

        <!-- Spazio flessibile (spinge Multipla a destra) -->
        <div style="flex:1;min-width:8px"></div>

        <!-- Selezione multipla -->
        ${selMode!=='wines'?`<button onclick="enterSel('wines')" style="${ctrlBase};${ctrlOff}">☑ Multipla</button>`:''}

      </div>
    </div>

    <!-- Popover Filtri Avanzati — position:fixed, compatto, contestuale -->
    <div id="inv-filter-panel" style="display:none;position:fixed;z-index:300;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.05);padding:16px;width:320px;max-height:70vh;overflow-y:auto">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <span style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3)">Filtri avanzati</span>
        <div style="display:flex;gap:6px;align-items:center">
          ${advCount>0?`<button onclick="_resetInvFilters()" style="padding:3px 10px;border-radius:6px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.07);color:#FF453A;font-size:9px;font-weight:600;cursor:pointer">✕ Reset</button>`:''}
          <button onclick="_closeInvFilterPanel()" style="width:24px;height:24px;border-radius:6px;border:1px solid var(--border2);background:var(--bg3);color:var(--txt3);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">×</button>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px">

        ${_fSection({title:`Vitigno${filterVitigni.size?` · ${filterVitigni.size} selez.`:''}`, multi:true, fkey:"vitigno",
          opts:[{v:"tutti",label:"Tutti"}, ...activeVitigni.map(v=>({v,label:v}))]})}

        ${_fSection({title:"Formato", fkey:"formato",
          opts:[{v:"tutti",label:"Tutti"}, ...activeFormati.map(f=>({v:String(f),label:f+"L"}))]})}

        ${_fSection({title:"Distributore", fkey:"distrib",
          opts:[{v:"tutti",label:"Tutti"}, ...activeDistrib.map(d=>({v:d,label:d}))]})}

        ${_fSection({title:"Produttore", fkey:"prod",
          opts:[{v:"tutti",label:"Tutti"}, ...activeProd.map(p=>({v:p,label:p}))]})}

        ${_fSection({title:"Regione", fkey:"regione",
          opts:[{v:"tutti",label:"Tutte"}, ...activeRegioni.map(r=>({v:r,label:r}))]})}

        ${_fSection({title:"Nazione", fkey:"nazione",
          opts:[{v:"tutti",label:"Tutte"}, ...activeNazioni.map(n=>({v:n,label:n}))]})}

      </div>
    </div>
    <div class="tbl-wrap">
      <table class="inv-table">
        <thead><tr>
          ${selMode==='wines'?`<th class="cb-col"><input type="checkbox" id="cb-sel-all" class="cb-sel" onchange="toggleSelAll()"></th>`:''}
          <th class="col-fornitore" style="color:var(--txt3)">Forn.</th><th>Produttore</th><th>Nome Vino</th><th class="col-annata" style="color:var(--txt3)">Annata</th><th class="col-vitigni" style="color:var(--txt3)">Vitigni</th><th>${badge('Tipo')}</th>
          <th class="col-regione" style="color:var(--txt3)">Regione / Nazione</th>
          <th class="r" style="border-left:1px solid var(--border)">P.Acq</th><th class="r col-ivaincl">+IVA/bt</th><th class="r col-pcarta">P.Carta</th><th class="r col-margperc">Marg.%</th>
          <th class="c" style="border-left:1px solid rgba(255,159,10,.2);background:rgba(255,159,10,.06);color:var(--amber3);min-width:72px">GIACENZA</th>
        </tr></thead>
        <tbody>
        ${list.length===0?`<tr><td colspan="13" style="text-align:center;padding:40px;color:var(--txt4)">Nessun vino trovato</td></tr>`:
        list.map((w,i_)=>{
          const prevTipo_=i_>0?list[i_-1].tipologia:"";
          const groupHdr_=(invSort==="tipologia"&&filterTipo==="tutti"&&w.tipologia!==prevTipo_)?
            `<tr style="background:var(--bg)"><td colspan="13" style="padding:8px 16px 5px;border-top:2px solid rgba(255,159,10,.25);border-bottom:1px solid rgba(255,159,10,.12)"><span style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--amber);font-weight:700">${h(w.tipologia)}</span>&emsp;<span style="font-size:9px;color:var(--txt4)">${tipoCountMap[w.tipologia]||0} etich.</span></td></tr>`
            : "";
          return groupHdr_+_renderWineRow(w);
        }).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
  return html;
}

function _getSoglie(wineId){
  const v = alertSoglie[wineId];
  if(v === undefined || v === null) return {min:3, riordino:6};
  if(typeof v === "number") return {min:v, riordino:Math.max(v+1, v*2)};
  return {min: v.min??3, riordino: v.riordino??6};
}
function _setSoglia(wineId, field, delta){
  const cur = _getSoglie(wineId);
  let {min, riordino} = cur;
  if(field==="min") min = Math.max(0, min+delta);
  else riordino = Math.max(min+1, riordino+delta);
  alertSoglie[wineId] = {min, riordino};
  scheduleSave(); renderInventarioOnly();
}


function _applyPrezzoCartaSuggerito(overwriteAll){
  const _doApply = () => {
    let count = 0;
    wines = wines.map(w => {
      if(!w.prezzoAcq) return w;
      if(!overwriteAll && w.prezzoCarta) return w;
      const suggerito = _calcPrezzoCartaSuggerito(w);
      if(!suggerito) return w;
      count++;
      return {...w, prezzoCarta: suggerito};
    });
    scheduleSave(); render();
    notify(`✅ P.Carta aggiornato su ${count} vini`);
  };
  if(overwriteAll){
    const n = wines.filter(w=>w.prezzoAcq>0).length;
    _confirmModal(
      `Ricalcola P.Carta per <strong>${n} vini</strong> con le fasce standard?<br><span style="font-size:11px;color:var(--txt4)">I prezzi già impostati verranno sovrascritti.</span>`,
      "✅ Ricalcola",
      _doApply,
      'warn'
    );
  } else {
    _doApply();
  }
}



function setSoglia(id,delta){
  // legacy shim — delegate to new dual-threshold setter
  _setSoglia(id,'min',delta);
}

function _toggleSogliaPop(wineId, btn){
  // Close any existing popover
  document.querySelectorAll('.soglia-pop').forEach(p=>p.remove());
  const sg = _getSoglie(wineId);
  const pop = document.createElement('div');
  pop.className = 'soglia-pop';
  pop.innerHTML = `
    <div class="soglia-pop-title">Alert Soglie</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span style="font-size:10px;color:#FF453A">🔴 Scorta min.</span>
        <div class="soglia-ctrl">
          <button class="soglia-btn" onclick="_setSoglia('${wineId}','min',-1);_refreshPop('${wineId}',this)">−</button>
          <span class="soglia-val sp-min" style="color:#FF453A">${sg.min}</span>
          <button class="soglia-btn" onclick="_setSoglia('${wineId}','min',1);_refreshPop('${wineId}',this)">+</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span style="font-size:10px;color:#fbbf24">🟡 Riordino</span>
        <div class="soglia-ctrl">
          <button class="soglia-btn" onclick="_setSoglia('${wineId}','riordino',-1);_refreshPop('${wineId}',this)">−</button>
          <span class="soglia-val sp-riord" style="color:#fbbf24">${sg.riordino}</span>
          <button class="soglia-btn" onclick="_setSoglia('${wineId}','riordino',1);_refreshPop('${wineId}',this)">+</button>
        </div>
      </div>
    </div>
    <div style="font-size:9px;color:var(--txt4);margin-top:8px;line-height:1.5">Rosso = togli da carta<br>Giallo = riordina dal fornitore</div>`;
  // Position below the button
  const rect = btn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.left = Math.max(4, rect.left - 60) + 'px';
  document.body.appendChild(pop);
  // Close on outside click
  setTimeout(()=>{ document.addEventListener('click', function close(e){ if(!pop.contains(e.target)&&e.target!==btn){pop.remove();document.removeEventListener('click',close);} }); }, 10);
}
function _refreshPop(wineId, el){
  const pop = el.closest('.soglia-pop');
  if(!pop) return;
  const sg = _getSoglie(wineId);
  const minEl = pop.querySelector('.sp-min');
  const riordEl = pop.querySelector('.sp-riord');
  if(minEl) minEl.textContent = sg.min;
  if(riordEl) riordEl.textContent = sg.riordino;
  // Also refresh the button in the table row
  const rowBtn = document.querySelector(`button[onclick*="_toggleSogliaPop('${wineId}'"]`);
  if(rowBtn) rowBtn.innerHTML = `<span style="color:#FF453A">${sg.min}</span>·<span style="color:#fbbf24">${sg.riordino}</span>`;
}

function _updateScaricoCounts(){
  // Conta solo righe visibili (filtro ricerca potrebbe nasconderne alcune)
  let totBt = 0, righe = 0;
  document.querySelectorAll("#ssp-table tbody tr, #scarico-serata-table tbody tr").forEach(tr => {
    if(tr.style.display === "none") return;
    const input = tr.querySelector("input[type=number]");
    if(!input) return;
    const q = parseInt(input.value)||0;
    if(q > 0){ totBt += q; righe++; }
  });
  // Calcola ricavo stimato in tempo reale
  let totRicavoStimato = 0;
  document.querySelectorAll("#ssp-table tbody tr, #scarico-serata-table tbody tr").forEach(tr => {
    if(tr.style.display === "none") return;
    const inp = tr.querySelector("input[type=number]");
    if(!inp) return;
    const wid = tr.dataset.wid;
    const q = parseInt(inp.value)||0;
    if(q > 0 && wid){
      const w = wines.find(x=>x.id===wid);
      if(w && w.prezzoCarta) totRicavoStimato += q * parseFloat(w.prezzoCarta);
    }
  });
  const el = document.getElementById("scarico-serata-count");
  if(el){
    el.innerHTML = righe > 0
      ? `<span style="color:#FF6B6B">${righe} vin${righe===1?"o":"i"}</span> · <span style="color:var(--amber)">${totBt} bottigli${totBt===1?"a":"e"}</span>${totRicavoStimato>0?` · <span style="color:#30D158;font-weight:600">~${fmt(totRicavoStimato)} ricavo</span>`:''} da scaricare`
      : `<span style="color:var(--txt4)">Inserisci le quantità finite</span>`;
  }
  const btn = document.querySelector(`button[onclick*="registraScaricaSerata"]`);
  if(btn){
    btn.disabled = righe === 0;
    btn.style.background = righe > 0 ? "var(--amber3)" : "rgba(58,58,60,.5)";
    btn.style.color = righe > 0 ? "#000" : "var(--txt4)";
    btn.style.cursor = righe > 0 ? "pointer" : "not-allowed";
    btn.textContent = `🍾 Registra ${righe > 0 ? `${righe} scarich${righe===1?"o":"i"}` : "scarichi"}`;
  }
}


function _ieriStr(){ const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().split("T")[0]; }
let scaricoSerata = {
  open: false,
  listCollapsed: false,
  get data(){ return this._data || _ieriStr(); },
  set data(v){ this._data = v; },
  note: "",
  sort: "nome",  // 'nome' | 'tipo' | 'giacenza'
  qtys: {} // wineId → qty string
};

function toggleScaricoPannello(){
  scaricoSerata.open = !scaricoSerata.open;
  render();
}

function registraScaricaSerata(){
  const righe = wines
    .filter(w => w.giacenza > 0)
    .map(w => ({ wine: w, qty: parseInt(scaricoSerata.qtys[w.id]) || 0 }))
    .filter(r => r.qty > 0);

  if(!righe.length){ notify("Inserisci almeno una quantità", "err"); return; }

  for(const r of righe){
    if(r.qty > r.wine.giacenza){
      notify(`Giacenza insufficiente per ${r.wine.nome} (${r.wine.giacenza} disponibili)`, "err");
      return;
    }
  }

  const data = scaricoSerata.data || (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().split("T")[0]; })();
  const note = scaricoSerata.note.trim();

  const scaricoByWineId = {};
  righe.forEach(r => { scaricoByWineId[r.wine.id] = { qty: r.qty }; });

  wines = wines.map(w => {
    const sc = scaricoByWineId[w.id];
    if(!sc) return w;
    let rem = sc.qty;
    const updLots = (w.lots||[]).map(l => {
      if(rem <= 0 || l.qtyRimanente <= 0) return l;
      const c = Math.min(rem, l.qtyRimanente);
      rem -= c;
      return {...l, qtyRimanente: l.qtyRimanente - c};
    });
    return {...w, giacenza: w.giacenza - sc.qty, lots: updLots};
  });

  const newMovs = righe.map(r => ({
    id: uid(), wineId: r.wine.id, wineName: r.wine.nome, produttore: r.wine.produttore, nazione: r.wine.nazione||"",
    tipo: "scarico", qty: r.qty, data, fattura: "", fornitore: "",
    costoUnitarioIva: calcCostoIvaBottiglia(r.wine),
    note: note || "Scarico serata", ts: Date.now()
  }));
  movements = [...newMovs, ...movements];

  const totBt = righe.reduce((s,r) => s + r.qty, 0);
  scaricoSerata.qtys = {};
  scaricoSerata.note = "";

  scheduleSave();
  notify(`🍾 ${righe.length} vin${righe.length===1?"o":"i"} scaricati — ${totBt} bottigli${totBt===1?"a":"e"} totali`);
  const _scSy=window.scrollY; render(); requestAnimationFrame(()=>window.scrollTo(0,_scSy));
}
// ─── SCARICO SINGOLA RIGA ─────────────────────────────────────────────────────
function registraScaricaSingoloVino(wineId){
  const qty = parseInt(scaricoSerata.qtys[wineId])||0;
  if(qty <= 0){ notify("⚠️ Inserisci una quantità per questo vino","err"); return; }
  const wine = wines.find(w => w.id === wineId);
  if(!wine){ notify("⚠️ Vino non trovato","err"); return; }
  if(qty > wine.giacenza){ notify(`⚠️ Giacenza insufficiente (${wine.giacenza} disponibili)`,"err"); return; }

  const data = scaricoSerata.data || (()=>{const d=new Date();d.setDate(d.getDate()-1);return d.toISOString().split("T")[0];})();
  const note = scaricoSerata.note.trim();

  // Aggiorna vino
  wines = wines.map(w => {
    if(w.id !== wineId) return w;
    let rem = qty;
    const updLots = (w.lots||[]).map(l => {
      if(rem<=0||l.qtyRimanente<=0) return l;
      const c = Math.min(rem,l.qtyRimanente); rem-=c;
      return {...l, qtyRimanente:l.qtyRimanente-c};
    });
    return {...w, giacenza:w.giacenza-qty, lots:updLots};
  });

  movements = [{
    id:uid(), wineId, wineName:wine.nome, produttore:wine.produttore, nazione:wine.nazione||"",
    tipo:"scarico", qty, data, fattura:"", fornitore:"",
    costoUnitarioIva: calcCostoIvaBottiglia(wine),
    note:note||"Scarico serata", ts:Date.now()
  }, ...movements];

  // Pulisce la qty dalla riga
  delete scaricoSerata.qtys[wineId];

  scheduleSave();
  notify(`🍾 ${wine.nome} — ${qty} bottigli${qty===1?"a":"e"} scaricata`);

  // Aggiorna solo la riga nel DOM senza re-render completo
  const tr = document.querySelector(`#ssp-table tr[data-wid="${wineId}"]`);
  if(tr){
    const newGiac = wines.find(w=>w.id===wineId)?.giacenza ?? 0;
    if(newGiac === 0){
      tr.remove(); // vino esaurito: rimuovi dalla lista
    } else {
      // Aggiorna giacenza e resetta input
      const giacEl = tr.querySelector('.ssp-giac');
      if(giacEl) giacEl.textContent = newGiac;
      const inp = tr.querySelector('input[type=number]');
      if(inp){ inp.value=''; inp.style.borderColor=''; inp.style.color=''; }
      const cb = tr.querySelector('input[type=checkbox]');
      if(cb) cb.checked = false;
      tr.style.background = '';
      // Aggiorna max
      if(inp) inp.max = newGiac;
    }
  }
  _updateScaricoCounts();
  updateSidebar();
}


// ─── MOVIMENTI ────────────────────────────────────────────────────────────────
function renderMovimenti(){
  const selW=wines.find(w=>w.id===movForm.wineId);

  let html = `<div class="kpi-grid g2" style="margin-bottom:20px">
    <div class="card">
      <div class="section-label"><span>📦 Registra Movimento</span></div>
      <div class="form-grid g2" style="margin-bottom:8px">
        <div><label class="form-label">Tipo</label>
          <select class="form-select" onchange="movForm.tipo=this.value;render()">
            <option value="carico" ${movForm.tipo==="carico"?"selected":""}>📦 Carico</option>
            <option value="scarico" ${movForm.tipo==="scarico"?"selected":""}>🍾 Scarico</option>
          </select>
        </div>
        <div><label class="form-label">Data</label><input class="form-input" type="date" value="${movForm.data}" oninput="movForm.data=this.value"></div>
      </div>
      ${movForm.tipo==="carico"?`
      <div class="form-grid g2" style="margin-bottom:8px">
        <div>
          <label class="form-label">Fornitore <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— opzionale</span></label>
          <input class="form-input" value="${h(movForm.fornitore)}" placeholder="es. Vini Italiani Srl" oninput="movForm.fornitore=this.value">
        </div>
        ${!selW?`<div>
          <label class="form-label">Produttore <span style="color:var(--amber3)">*</span></label>
          <datalist id="mov-prod-dl">${[...new Set(wines.map(w=>w.produttore).filter(Boolean))].sort().map(p=>`<option value="${h(p)}">`).join("")}</datalist>
          <input id="mov-prod-input" class="form-input" list="mov-prod-dl" autocomplete="off"
            placeholder="es. Giacomo Conterno" value="${movForm._newProduttore||''}"
            oninput="movForm._newProduttore=this.value">
        </div>`:'<div></div>'}
      </div>`:``}
      <div class="form-row" style="margin-bottom:8px">
        <label class="form-label">Vino <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— cerca per nome, produttore o annata</span></label>
        <datalist id="mov-wine-dl">
          ${wines.map(w=>`<option value="${h(w.nome+' \u2014 '+w.produttore+(w.annata?' ('+w.annata+')':'')+' ['+w.tipologia+']')}">`).join("")}
        </datalist>
        <div style="display:flex;gap:6px">
          <input id="mov-wine-input" class="form-input" list="mov-wine-dl" autocomplete="off"
            placeholder="es. Petricore \u2014 Valentini (2025) [Bianco]"
            value="${selW?(h(selW.nome)+' \u2014 '+h(selW.produttore)+(selW.annata?' ('+h(selW.annata)+')':'')):(movForm._wineText||'')}"
            style="flex:1"
            oninput="_movWineMatchSilent(this.value.trim())"
            onchange="_movWineMatch(this.value.trim());_movWineUpdatePanel()">
          ${selW?'<button onclick="movForm.wineId=\'\';movForm._wineText=\'\';movForm._newMode=false;render()" style="flex-shrink:0;padding:0 10px;border:1px solid var(--border2);color:var(--txt3);background:none;cursor:pointer;font-size:13px;border-radius:var(--radius-sm)" title="Cambia vino">\u2715</button>':''}
        </div>
        ${selW?`<div style="margin-top:6px;display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,159,10,.06);border:1px solid rgba(255,159,10,.15);border-radius:var(--radius-sm);flex-wrap:wrap">
            ${badge(selW.tipologia)}
            <span style="color:var(--txt2);font-size:12px;font-weight:500">${h(selW.nome)}</span>
            <span style="color:var(--txt3);font-size:11px">${h(selW.produttore)}</span>
            <span style="color:var(--amber);font-family:'Montserrat',sans-serif">${selW.annata?h(selW.annata):'N.V.'}</span>
            ${selW.vitigni?('<span style="color:var(--txt4);font-size:10px">\ud83c\udf47 '+h(selW.vitigni)+'</span>'):''}
            <span style="margin-left:auto;color:var(--amber);font-family:'Montserrat',sans-serif;font-size:1.1rem">${selW.giacenza} bt</span>
          </div>
          ${movForm.tipo==="carico"?('<div style="margin-top:6px"><button onclick="movForm._newMode=true;movForm.wineId=\'\';movForm._newProduttore=\''+h(selW.produttore)+'\';movForm._newTipologia=\''+selW.tipologia+'\';movForm._newVitigni=\''+h(selW.vitigni||'')+'\';movForm._newRegione=\''+h(selW.regione||'')+'\';movForm._newNazione=\''+h(selW.nazione||'Italia')+'\';movForm._newZona=\''+h(selW.zona||'')+'\';movForm._wineText=\'\';render()" style="font-size:10px;font-weight:600;padding:4px 12px;border:1px solid rgba(255,159,10,.4);color:var(--amber);background:rgba(255,159,10,.1);cursor:pointer;font-family:inherit;border-radius:6px">\u2746 Nuova annata / variante di questo vino</button></div>'):''}`:''
        }
        ${(!selW&&movForm._wineText&&!movForm.wineId&&!movForm._newMode)?
          ('<div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:10px;color:var(--txt3)">Vino non trovato in cantina.</span>'
          +(movForm.tipo==="carico"?'<button onclick="movForm._newMode=true;render()" style="font-size:10px;font-weight:600;padding:4px 12px;border:1px solid rgba(48,209,88,.35);color:#30D158;background:rgba(48,209,88,.08);cursor:pointer;font-family:inherit;border-radius:6px">\u2746 Crea nuova referenza</button>':'<span style="color:#FF453A;font-size:10px">Impossibile scaricare \u2014 vino non in cantina</span>')
          +'</div>')
          :''}
      </div>

      ${(movForm.tipo==="carico"&&movForm._newMode&&!movForm.wineId)?`
      <div style="background:rgba(48,209,88,.04);border:1px solid rgba(48,209,88,.2);padding:14px;margin-bottom:8px;border-radius:var(--radius-sm)">
        <div style="font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#30D158;margin-bottom:12px">\u2746 Nuova Referenza &mdash; dati completi per la carta vini</div>
        <div class="form-grid g2" style="margin-bottom:8px">
          <div><label class="form-label">Nome Vino *</label>
            <input class="form-input" placeholder="es. Petricore" value="${h(movForm._wineText||'')}"
              oninput="movForm._wineText=this.value;movForm.wineId='';_movUpdateCartaPreview()">
          </div>
          <div><label class="form-label">Produttore *</label>
            <datalist id="mov-prod-dl2">${[...new Set(wines.map(w=>w.produttore).filter(Boolean))].sort().map(p=>`<option value="${h(p)}">`).join("")}</datalist>
            <input class="form-input" list="mov-prod-dl2" autocomplete="off" placeholder="es. Valentini"
              value="${h(movForm._newProduttore||'')}" oninput="movForm._newProduttore=this.value;_movUpdateCartaPreview()">
          </div>
          <div><label class="form-label">Annata</label>
            <input class="form-input" placeholder="es. 2025 o N.V." value="${h(movForm._newAnnata||'')}"
              oninput="movForm._newAnnata=this.value;_movUpdateCartaPreview()">
          </div>
          <div><label class="form-label">Tipologia *</label>
            <select class="form-select" data-prev="Rosso" onchange="_addTipologiaInline(this,(v)=>_movTipologiaChange(v));if(this.value!=='__new__'){this.dataset.prev=this.value;_movTipologiaChange(this.value)}">
              ${_tipoOptsHtml(movForm._newTipologia||'Rosso')}
            </select>
          </div>
          <div><label class="form-label">Vitigni</label>
            <input class="form-input" placeholder="es. Trebbiano 100%" value="${h(movForm._newVitigni||'')}"
              oninput="movForm._newVitigni=this.value;_movUpdateCartaPreview()">
          </div>
          <div><label class="form-label">Zona / Cru</label>
            <input class="form-input" placeholder="es. Vigna Gamberale" value="${h(movForm._newZona||'')}"
              oninput="movForm._newZona=this.value">
          </div>
          <div><label class="form-label">Regione</label>
            <input class="form-input" placeholder="es. Abruzzo" value="${h(movForm._newRegione||'')}"
              oninput="movForm._newRegione=this.value">
          </div>
          <div><label class="form-label">Nazione</label>
            <input class="form-input" placeholder="es. Italia" value="${h(movForm._newNazione||'Italia')}"
              oninput="movForm._newNazione=this.value">
          </div>
          <div><label class="form-label">Prezzo in Carta \u20ac</label>
            <input class="form-input" type="number" step="0.5" min="0" placeholder="0.00"
              value="${movForm._newPrezzoCarta||''}" oninput="movForm._newPrezzoCarta=this.value;_movUpdateCartaPreview()">
          </div>
          <div><label class="form-label">Distributore</label>
            <input class="form-input" placeholder="es. Vini Italiani Srl"
              value="${h(movForm._newDistributore||'')}" oninput="movForm._newDistributore=this.value">
          </div>
          <div><label class="form-label">IVA %</label>
            <select class="form-select" onchange="movForm._newIva=parseInt(this.value)">
              ${[4,10,22].map(v=>`<option value="${v}" ${(movForm._newIva||22)===v?"selected":""}>${v}%</option>`).join("")}
            </select>
          </div>
          <div><label class="form-label">Prezzo Acquisto (escl. IVA) €</label>
            <input class="form-input" type="number" step="0.01" min="0" placeholder="0.00"
              value="${movForm.prezzoAcqLotto||''}" oninput="movForm.prezzoAcqLotto=this.value;_movUpdateCartaPreview()">
          </div>
          <div style="grid-column:span 2">
            <div id="mov-new-preview" style="display:none;padding:10px 14px;background:rgba(0,122,255,.06);border:1px solid rgba(0,122,255,.2);border-radius:var(--radius-sm);font-size:11px">
              <span style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#007AFF">📋 Anteprima carta vini</span>
              <div id="mov-new-preview-body" style="margin-top:6px;color:var(--txt2)"></div>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <button onclick="movForm._newMode=false;movForm.wineId='';movForm._wineText='';render()"
            style="font-size:10px;padding:4px 10px;border:1px solid var(--border2);color:var(--txt3);background:none;cursor:pointer;font-family:inherit;border-radius:6px">\u2715 Annulla</button>
          <span style="font-size:10px;color:var(--txt4)">La referenza verrà creata al momento del Registra Carico</span>
        </div>
      </div>`:''}

      <div class="form-grid g2" style="margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm)">
          <span style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--txt4)">Qtà</span>
          <input id="mov-qty-input" class="form-input" type="number" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" min="1" value="${movForm.qty}" oninput="movForm.qty=this.value" style="text-align:center;font-family:'Montserrat',sans-serif;font-size:1.2rem;background:none;border:none;padding:0;width:60px">
          <span style="font-size:11px;color:var(--txt3)">bottiglie</span>
        </div>
        <div></div>
      </div>
      ${movForm.tipo==="carico"?`
      ${!movForm._newMode?`
      <div class="form-grid g2" style="margin-bottom:8px">
        <div>
          <label class="form-label">Prezzo Acquisto Lotto (escl. IVA) € <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— vuoto = prezzo attuale</span></label>
          <input class="form-input" type="number" value="${movForm.prezzoAcqLotto}" placeholder="${selW?fmtN(selW.prezzoAcq):"0.00"}" oninput="movForm.prezzoAcqLotto=this.value">
        </div>
        <div>
          <label class="form-label">Prezzo in Carta € <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— opzionale</span></label>
          <input class="form-input" type="number" step="0.5" min="0" placeholder="${selW?fmtN(selW.prezzoCarta||0):"0.00"}"
            value="${selW?h(String(selW.prezzoCarta||'')):''}'"
            ${selW?'disabled':''}
            oninput="movForm._newPrezzoCarta=this.value">
        </div>
      </div>`:''
      }
      <div class="form-row" style="margin-bottom:8px">
        <label class="form-label">N° Fattura <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— opzionale</span></label>
        <input class="form-input" value="${h(movForm.fattura)}" placeholder="FT-2024-001" oninput="movForm.fattura=this.value">
      </div>`:`
      <div class="form-row" style="margin-bottom:8px">
        <label class="form-label">N° Fattura <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— opzionale</span></label>
        <input class="form-input" value="${h(movForm.fattura)}" placeholder="FT-2024-001" oninput="movForm.fattura=this.value">
      </div>`}
      ${movForm.tipo==="scarico"?``:''}
      <div class="form-row" style="margin-top:4px"><label class="form-label">Note</label><input class="form-input" value="${h(movForm.note)}" placeholder="Note aggiuntive…" oninput="movForm.note=this.value"></div>
      ${selW?`<div class="info-panel">
        <div><div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:4px">P.Carta/bt</div><div style="color:${selW.prezzoCarta?"#30D158":"#fb923c"};font-family:'Montserrat',sans-serif;font-size:13px">${selW.prezzoCarta?fmt(parseFloat(selW.prezzoCarta)):'<span style="font-size:10px;letter-spacing:.1em">⚠ NON IMP.</span>'}</div></div>
        <div><div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:4px">Costo+IVA/bt</div><div style="color:var(--amber);font-family:inherit;font-size:13px">${fmtRound(calcCostoIvaBottiglia(selW))}</div></div>
        <div><div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:4px">Marg. Lordo/bt</div><div style="color:${(calcMargineBottiglia(selW)||0)>=0?"#007AFF":"#FF453A"};font-size:13px">${calcMargineBottiglia(selW)===null?"—":fmt(calcMargineBottiglia(selW))}</div></div>
        <div><div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:4px">Marg. %</div><div style="color:${(calcMarginePerc(selW)||0)>=0?"#30D158":"#FF453A"};font-size:13px">${calcMarginePerc(selW)===null?"—":`${fmtN(calcMarginePerc(selW),1)}%`}</div></div>
      </div>
      ${!selW.prezzoCarta?`<div style="margin-top:8px;padding:8px 10px;background:rgba(255,159,10,.08);border:1px solid rgba(180,83,9,.3);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:10px;color:var(--txt3);letter-spacing:.1em;text-transform:uppercase;flex-shrink:0">⚠ Imposta P.Carta ora:</span>
        <input type="number" id="mov-quick-carta" class="form-input" style="width:100px;padding:4px 8px;font-size:11px" placeholder="0.00" step="0.5" min="0">
        <button class="btn-outline btn-sm" onclick="_setQuickCarta('${selW.id}')">Salva</button>
      </div>`:""}
      `:""}
      <button class="${movForm.tipo==="carico"?"btn-green":"btn-primary"}" style="width:100%;justify-content:center;margin-top:14px" onclick="registraMovimento()">
        ${movForm.tipo==="carico"?"📦 Registra Carico":"🍾 Registra Scarico"}
      </button>
    </div>
    <div class="card">
      <div class="section-label"><span># Log Recenti</span></div>
      <div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
        ${movements.length===0?`<div style="text-align:center;padding:28px;color:var(--txt4);font-size:11px">Nessun movimento</div>`:
        movements.slice(0,10).map(m=>`<div class="move-log"><span style="color:${m.tipo==="carico"?"#30D158":"#FF453A"}">${m.tipo==="carico"?"⬆":"⬇"}</span><div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(m.wineName)}</div><div style="color:var(--txt4);font-size:10px">${h(m.data)}${m.fattura?" · "+h(m.fattura):""}</div></div><span style="font-family:'Montserrat',sans-serif;color:${m.tipo==="carico"?"#30D158":"#FF453A"};font-size:1rem">${m.tipo==="carico"?"+":"-"}${m.qty}</span></div>`).join("")}
      </div>
    </div>
  </div>
  <div class="card" style="padding:0">
    ${selMode==='movimenti'?renderBulkBar('movimenti', movements.map(m=>m.id)):''}
    <div class="tbl-header">
      <span style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt3)">Storico Completo — ${movements.length} movimenti</span>
      <div style="display:flex;gap:8px">
        ${selMode!=='movimenti'?`<button class="btn-outline btn-sm" onclick="enterSel('movimenti')" style="border-color:rgba(59,130,246,.5);color:#93c5fd">☑ Selezione multipla</button>`:''}
        <button class="btn-outline btn-sm" onclick="exportMovimentiCSV()">↓ CSV</button>
      </div>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>${selMode==='movimenti'?`<th class="cb-col"><input type="checkbox" id="cb-sel-all" class="cb-sel" onchange="toggleSelAll()"></th>`:''}<th>Data</th><th>Tipo</th><th>Vino</th><th>Vitigni</th><th>Annata</th><th>Produttore</th><th>Nazione</th><th>N° Fattura</th><th>Fornitore</th><th class="r">Qtà</th><th class="r">P.Acq+IVA</th><th class="r">P.Carta/Ricavo</th><th>Note</th><th class="c"></th></tr></thead>
        <tbody>
          ${movements.length===0?`<tr><td colspan="10" style="text-align:center;padding:28px;color:var(--txt4)">Nessun movimento registrato</td></tr>`:
          (()=>{ const wMap=Object.fromEntries(wines.map(w=>[w.id,w])); return movements.map(m=>{const wObj=wMap[m.wineId]; const wAnn=wObj?.annata||""; const costoIva=wObj?calcCostoIvaBottiglia(wObj):0; return `<tr data-sel-id="${m.id}">${selMode==='movimenti'?`<td class="cb-col"><input type="checkbox" class="cb-sel" data-id="${m.id}" onchange="toggleSel('${m.id}');_updateBulkBar()"></td>`:''}<td style="color:var(--txt2)">${h(m.data)}</td><td><span style="font-size:9px;padding:2px 8px;border:1px solid;${m.tipo==="carico"?"background:rgba(20,83,45,.3);color:#30D158;border-color:#166534":"background:rgba(255,69,58,.12);color:#FF6B6B;border-color:#CC3025"}">${h(m.tipo.toUpperCase())}</span></td><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(m.wineName)}</td><td style="color:var(--txt3);font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(wObj?.vitigni||"—")}</td><td style="color:var(--amber);font-family:'Montserrat',sans-serif;white-space:nowrap">${wAnn?h(wAnn):'<span style="color:var(--txt4)">N.V.</span>'}</td><td style="color:var(--txt2);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(m.produttore||"—")}</td><td style="color:var(--amber3);font-size:10px;white-space:nowrap">${h(m.nazione||wObj?.nazione||"—")}</td><td style="color:var(--txt3)">${h(m.fattura||"—")}</td><td style="color:var(--txt3)">${h(m.fornitore||"—")}</td><td class="r" style="font-family:'Montserrat',sans-serif;color:${m.tipo==="carico"?"#30D158":"#FF453A"};font-size:1rem">${m.tipo==="carico"?"+":"-"}${m.qty}</td><td class="r" style="color:var(--txt3);white-space:nowrap">${costoIva?fmt(costoIva):"—"}</td><td class="r" style="color:var(--amber);white-space:nowrap">${wObj?.prezzoCarta?fmt(parseFloat(wObj.prezzoCarta)):"—"}</td><td style="color:var(--txt4);font-size:10px">${h(m.note||"—")}</td><td class="c"><button onclick="openMovModal('${m.id}')" style="background:none;border:1px solid var(--border2);color:var(--txt3);font-size:11px;padding:3px 8px;cursor:pointer;font-family:inherit;transition:all .15s" onmouseover="this.style.borderColor='var(--amber3)';this.style.color='var(--amber)'" onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--txt3)'">✏️</button></td></tr>`; }).join(""); })() }
        </tbody>
      </table>
    </div>
  </div>

  <!-- MODAL MODIFICA MOVIMENTO -->
  <div class="modal-backdrop hidden" id="mov-edit-backdrop" onclick="closeMovModal(event)">
    <div class="modal" style="max-width:560px" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>✏️ Modifica Movimento</h2>
        <button style="font-size:18px;color:var(--txt3)" onclick="closeMovModal()">✕</button>
      </div>
      <div class="modal-body" id="mov-edit-body"></div>
      <div class="modal-footer">
        <button class="btn-outline" onclick="closeMovModal()">Annulla</button>
        <button class="btn-primary" onclick="saveMovEdit()">💾 Salva Modifiche</button>
      </div>
    </div>
  </div>`;
  return html;
}

// ─── SCARICO SERATA STANDALONE PAGE ──────────────────────────────────────────
function renderScaricoSerataPage(){
  const sortKey = scaricoSerata.sort || 'nome';
  const listCollapsed = scaricoSerata.listCollapsed || false;
  const winiBase = wines.filter(w => w.giacenza > 0);
  const winiDisponibili = winiBase.slice().sort((a,b) => {
    if(sortKey === 'giacenza') return b.giacenza - a.giacenza || a.nome.localeCompare(b.nome);
    if(sortKey === 'tipo') return a.tipologia.localeCompare(b.tipologia) || a.nome.localeCompare(b.nome);
    return a.nome.localeCompare(b.nome);
  });
  const righeValide = winiDisponibili.filter(w=>(parseInt(scaricoSerata.qtys[w.id])||0)>0).length;
  const totDaScarico = winiDisponibili.reduce((s,w)=>s+(parseInt(scaricoSerata.qtys[w.id])||0),0);
  const ricavoTot = winiDisponibili.reduce((s,w)=>{
    const q=parseInt(scaricoSerata.qtys[w.id])||0;
    return s+(q&&w.prezzoCarta?q*parseFloat(w.prezzoCarta):0);
  },0);
  const sortBtn = (key, label) => {
    const active = sortKey === key;
    return `<button onclick="const _sy=window.scrollY;scaricoSerata.sort='${key}';render();requestAnimationFrame(()=>window.scrollTo(0,_sy))" style="font-size:10px;font-weight:${active?'700':'500'};padding:4px 12px;border:1px solid ${active?'rgba(255,159,10,.5)':'var(--border2)'};color:${active?'var(--amber)':'var(--txt3)'};background:${active?'rgba(255,159,10,.1)':'none'};cursor:pointer;font-family:inherit;border-radius:6px;transition:all .15s">${label}</button>`;
  };

  // ── sticky action bar (sempre visibile, anche a lista collassata) ──
  const actionBarHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:rgba(28,28,30,.95);border-top:1px solid rgba(255,159,10,.18);position:sticky;bottom:0;z-index:10;backdrop-filter:blur(8px)">
      <div id="scarico-serata-count" style="font-size:12px;color:var(--txt3)">
        ${righeValide>0
          ? `<span style="color:#FF6B6B;font-family:'Montserrat',sans-serif;font-size:1.1rem">${righeValide}</span> vin${righeValide===1?'o':'i'} · <span style="color:var(--amber);font-family:'Montserrat',sans-serif;font-size:1.1rem">${totDaScarico}</span> bottigli${totDaScarico===1?'a':'e'}${ricavoTot>0?` · <span style="color:#30D158;font-family:'Montserrat',sans-serif">${fmt(ricavoTot)}</span>`:''}`
          : `<span style="color:var(--txt4)">Inserisci le quantità finite</span>`}
      </div>
      <button class="btn-primary"
        style="background:${righeValide>0?"var(--amber3)":"rgba(58,58,60,.5)"};color:${righeValide>0?"#000":"var(--txt4)"};cursor:${righeValide>0?"pointer":"not-allowed"};padding:10px 24px;font-size:11px"
        ${righeValide===0?"disabled":""}
        onclick="const _sy=window.scrollY;registraScaricaSerata();_reportInlineOpen=true;setTimeout(()=>{const b=document.getElementById('report-inline-body');const a=document.getElementById('report-inline-arrow');if(b){b.style.display='block';b.innerHTML=_renderReportBody(reportSerataData);}if(a){a.className='report-toggle-arrow open';}window.scrollTo(0,_sy);},200)">
        Registra ${righeValide>0?righeValide+' scarich'+(righeValide===1?'o':'i'):'scarichi'}
      </button>
    </div>`;

  return `<div class="card" style="margin-bottom:16px;padding-bottom:0;overflow:hidden">
    <div style="padding:20px 20px 16px">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px">
        <div style="flex:1;min-width:200px">
          <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt3);margin-bottom:6px">Data Serata</div>
          <input type="date" class="form-input" style="max-width:200px" value="${scaricoSerata.data}"
            oninput="scaricoSerata.data=this.value">
        </div>
        <div style="flex:2;min-width:200px">
          <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt3);margin-bottom:6px">Note</div>
          <input class="form-input" placeholder="Note serata..." value="${h(scaricoSerata.note||'')}"
            oninput="scaricoSerata.note=this.value">
        </div>
      </div>

      <!-- header collassabile lista vini -->
      <div onclick="scaricoSerata.listCollapsed=!scaricoSerata.listCollapsed;render()"
        style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:10px 14px;border-radius:8px;border:1px solid ${listCollapsed?'rgba(255,159,10,.3)':'var(--border2)'};background:${listCollapsed?'rgba(255,159,10,.06)':'rgba(41,37,36,.3)'};margin-bottom:${listCollapsed?'0':'14px'};transition:all .2s;user-select:none">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:14px">🍷</span>
          <div>
            <span style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${listCollapsed?'var(--amber)':'var(--txt2)'}">Lista Vini</span>
            <span style="font-size:10px;color:var(--txt4);margin-left:8px">${winiDisponibili.length} referenze disponibili</span>
          </div>
          ${righeValide>0?`<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:rgba(255,69,58,.15);border:1px solid rgba(255,69,58,.3);color:#FF6B6B;font-family:'Montserrat',sans-serif">${righeValide} selezionat${righeValide===1?'o':'i'}</span>`:''}
        </div>
        <span style="color:var(--amber3);font-size:12px;font-weight:600;transition:transform .2s;display:inline-block;transform:rotate(${listCollapsed?'0':'180'}deg)">▼</span>
      </div>
    </div>

    <!-- corpo lista vini (collassabile) -->
    <div id="ssp-list-body" style="display:${listCollapsed?'none':'block'}">
      <div style="padding:0 20px 10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:10px;color:var(--txt4);letter-spacing:.1em;text-transform:uppercase">Ordina:</span>
          ${sortBtn('nome','↕ Nome')}
          ${sortBtn('tipo','↕ Tipo')}
          ${sortBtn('giacenza','↕ Giacenza ↓')}
          <div style="flex:1;min-width:160px;position:relative;margin-left:8px">
            <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--txt3);pointer-events:none;font-size:12px">&#128269;</span>
            <input type="text" class="form-input" style="padding-left:28px" placeholder="Cerca vino, produttore, annata..."
              oninput="(function(v){document.querySelectorAll('#ssp-table tbody tr').forEach(tr=>{const txt=tr.textContent.toLowerCase();tr.style.display=txt.includes(v.toLowerCase())?'':'none'})})(this.value)">
          </div>
        </div>
      </div>
      <div style="overflow-x:auto"><table id="ssp-table" style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left">Vino</th>
          <th style="text-align:left">Produttore</th>
          <th style="text-align:center">${badge('Tipo')}</th>
          <th style="text-align:center;color:var(--amber3);background:rgba(255,159,10,.08);cursor:pointer" onclick="const _sy=window.scrollY;scaricoSerata.sort='giacenza';render();requestAnimationFrame(()=>window.scrollTo(0,_sy))" title="Ordina per giacenza">Giacenza${sortKey==='giacenza'?' ↓':''}</th>
          <th style="text-align:center;color:var(--txt);background:rgba(255,69,58,.08);min-width:110px">Scarico</th>
          <th style="text-align:right;color:#30D158;background:rgba(48,209,88,.06);min-width:80px">Ricavo</th>
          <th style="width:52px;background:rgba(255,69,58,.08)"></th>
        </tr></thead>
        <tbody>
          ${winiDisponibili.map(w=>{
            const qVal=scaricoSerata.qtys[w.id]||"";
            const qNum=parseInt(qVal)||0;
            const overLimit=qNum>w.giacenza;
            const hasVal=qNum>0;
            return `<tr data-wid="${w.id}" style="${hasVal?"background:rgba(255,69,58,.06)":""}">
              <td style="word-break:break-word;white-space:normal;min-width:90px">
                <div style="font-size:13px;${hasVal?"color:var(--txt)":"color:var(--txt2)"};word-break:break-word;white-space:normal;line-height:1.35">${h(w.nome)}</div>
                ${w.annata?`<div style="font-size:10px;color:var(--amber);margin-top:1px">${h(w.annata)}</div>`:''}
                <div style="font-size:10px;color:var(--txt4);margin-top:1px" class="ssp-prod-mobile">${h(w.produttore)}</div>
              </td>
              <td style="color:var(--txt3);font-size:11px" class="ssp-col-desktop">${h(w.produttore)}</td>
              <td style="text-align:center">${badge(w.tipologia)}</td>
              <td class="ssp-giac" style="text-align:center;font-family:'Montserrat',sans-serif;font-size:1.1rem;color:var(--amber3);background:rgba(255,159,10,.05)">${w.giacenza}</td>
              <td style="text-align:center;background:rgba(255,69,58,.04)">
                <input type="number" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" min="0" max="${w.giacenza}" step="1" class="form-input"
                  style="width:80px;text-align:center;font-family:'Montserrat',sans-serif;font-size:1.1rem;padding:4px 8px;${overLimit?"border-color:#ef4444;color:#FF453A":hasVal?"border-color:rgba(239,68,68,.5);color:#FF6B6B":""}"
                  value="${qVal}" placeholder="0"
                  oninput="scaricoSerata.qtys['${w.id}']=this.value;const cb=document.querySelector('#ssp-table tr[data-wid=\\'${w.id}\\'] input[type=checkbox]');if(cb)cb.checked=(parseInt(this.value)||0)>0;_updateScaricoCounts()">
              </td>
              <td class="ssp-ricavo-${w.id}" style="text-align:right;font-size:11px;color:${hasVal&&w.prezzoCarta?'#30D158':'var(--txt4)'};background:rgba(48,209,88,.04);padding:4px 10px;white-space:nowrap">
                ${hasVal&&w.prezzoCarta?fmt(qNum*parseFloat(w.prezzoCarta)):'—'}
              </td>
              <td style="text-align:center;padding:4px 6px;background:rgba(255,69,58,.04)">
                <button onclick="registraScaricaSingoloVino('${w.id}')"
                  style="width:40px;height:40px;border-radius:8px;border:1px solid rgba(255,69,58,.4);background:rgba(255,69,58,.15);color:#FF6B6B;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s"
                  onmouseover="if((parseInt(scaricoSerata.qtys['${w.id}'])||0)>0){this.style.background='rgba(255,69,58,.35)';this.style.color='#fff'}"
                  onmouseout="this.style.background='rgba(255,69,58,.15)';this.style.color='#FF6B6B'"
                  title="Scarica ora questo vino">✓</button>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>

    ${actionBarHtml}
  </div>
  <div class="report-inline-panel">
    <div class="report-inline-toggle" onclick="toggleReportInline()">
      <div class="report-toggle-label">📋 Report & Storico Serata</div>
      <span class="report-toggle-arrow${_reportInlineOpen?' open':''}" id="report-inline-arrow">▼</span>
    </div>
    <div id="report-inline-body" style="display:${_reportInlineOpen?'block':'none'};padding-bottom:24px">
      ${_reportInlineOpen ? _renderReportBody(reportSerataData) : ""}
    </div>
  </div>
  <style>
    @media(min-width:600px){
      .ssp-col-desktop{display:table-cell!important}
      .ssp-prod-mobile{display:none!important}
    }
    @media(max-width:599px){
      .ssp-col-desktop{display:none!important}
      .ssp-prod-mobile{display:block!important}
    }
  </style>
`;

}

let reportSerataData = today();
let _reportInlineOpen = false;
function toggleReportInline(){
  _reportInlineOpen = !_reportInlineOpen;
  const body = document.getElementById("report-inline-body");
  const arrow = document.getElementById("report-inline-arrow");
  if(body){ body.style.display = _reportInlineOpen ? "block" : "none"; }
  if(arrow){ arrow.className = "report-toggle-arrow" + (_reportInlineOpen ? " open" : ""); }
  if(_reportInlineOpen){ document.getElementById("report-inline-body").innerHTML = _renderReportBody(reportSerataData); }
}
function _renderReportBody(dataSelezionata){
  const wineMap = Object.fromEntries(wines.map(w=>[w.id,w]));
  const dateConScarichi = [...new Set(movements.filter(m=>m.tipo==="scarico").map(m=>m.data))].sort((a,b)=>b.localeCompare(a));
  const scarichi = movements.filter(m=>m.tipo==="scarico"&&m.data===dataSelezionata).sort((a,b)=>(b.ts||0)-(a.ts||0));
  const totBt = scarichi.reduce((s,m)=>s+m.qty,0);
  const totRicavo = scarichi.reduce((s,m)=>s+calcRicavoMovimento(m,wineMap[m.wineId]),0);
  const totCosto = scarichi.reduce((s,m)=>s+calcCostoMovimento(m,wineMap[m.wineId]),0);
  const totMargine = totRicavo - totCosto;
  const byTipo = {};
  scarichi.forEach(m=>{const w=wineMap[m.wineId];const t=w?.tipologia||"—";if(!byTipo[t])byTipo[t]={bt:0,ricavo:0};byTipo[t].bt+=m.qty;byTipo[t].ricavo+=calcRicavoMovimento(m,w);});
  const byWine = {};
  scarichi.forEach(m=>{const w=wineMap[m.wineId];const k=m.wineId||m.wineName;if(!byWine[k])byWine[k]={nome:m.wineName,produttore:m.produttore||w?.produttore||"",tipologia:w?.tipologia||"",bt:0,ricavo:0};byWine[k].bt+=m.qty;byWine[k].ricavo+=calcRicavoMovimento(m,w);});
  const topWines = Object.values(byWine).sort((a,b)=>b.bt-a.bt);

  // ── date selector ──
  const dateSel = `<div style="margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div><div style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--txt3);margin-bottom:6px">Data</div>
    <input type="date" class="form-input" style="max-width:170px" value="${dataSelezionata}"
      oninput="reportSerataData=this.value;document.getElementById('report-inline-body').innerHTML=_renderReportBody(this.value)"></div>
    ${dateConScarichi.length>0?`<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end">
      ${dateConScarichi.slice(0,5).map(d=>`<button onclick="reportSerataData='${d}';document.getElementById('report-inline-body').innerHTML=_renderReportBody('${d}')" style="font-size:11px;font-weight:500;padding:4px 10px;border:1px solid ${d===dataSelezionata?"rgba(255,159,10,.4)":"var(--border2)"};color:${d===dataSelezionata?"var(--amber)":"var(--txt3)"};background:${d===dataSelezionata?"rgba(255,159,10,.08)":"none"};cursor:pointer;font-family:inherit;border-radius:6px">${d}</button>`).join("")}
    </div>`:""}
    ${scarichi.length>0?`<button class="btn-outline btn-sm" style="margin-left:auto" onclick="exportReportSerataCSV('${dataSelezionata}')">↓ CSV</button>`:""}
  </div>`;

  if(scarichi.length===0) return dateSel +
    `<div style="text-align:center;padding:32px;color:var(--txt4);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm)">Nessuno scarico per ${dataSelezionata}</div>`;

  // ── KPI strip ──
  const kpiHtml = `<div class="kpi-grid g4" style="margin-bottom:14px">
    <div class="kpi-card"><div class="kpi-label">Bottiglie</div><div class="kpi-val c-amber">${totBt}</div></div>
    <div class="kpi-card"><div class="kpi-label">Ricavo Stimato</div><div class="kpi-val c-green">${fmt(totRicavo)}</div></div>
    <div class="kpi-card"><div class="kpi-label">Costo Merce</div><div class="kpi-val c-amber">${fmt(totCosto)}</div></div>
    <div class="kpi-card"><div class="kpi-label">Margine Lordo</div><div class="kpi-val" style="color:${totMargine>=0?"#30D158":"#FF453A"}">${fmt(totMargine)}</div><div class="kpi-sub">${totRicavo?fmtN(totMargine/totRicavo*100,1)+"% sul ricavo":"—"}</div></div>
  </div>`;

  // ── breakdown per tipologia + vini ──
  const breakdownHtml = `<div class="kpi-grid g2" style="margin-bottom:14px">
    <div class="card">
      <div class="section-label"><span>Per Tipologia</span></div>
      ${Object.entries(byTipo).sort((a,b)=>b[1].bt-a[1].bt).map(([t,v])=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${badge(t)}<div style="flex:1;height:4px;background:var(--bg3);border-radius:2px"><div style="height:4px;background:var(--amber);border-radius:2px;width:${totBt?Math.round(v.bt/totBt*100):0}%"></div></div><span style="color:var(--txt2);font-size:12px;width:40px;text-align:right">${v.bt} bt</span><span style="color:var(--amber);font-size:12px;width:80px;text-align:right">${fmt(v.ricavo)}</span></div>`).join("")}
    </div>
    <div class="card">
      <div class="section-label"><span>Vini Scaricati</span></div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--txt4)">
          <td style="padding:4px 8px">Vino</td><td style="padding:4px 8px">Tipo</td><td style="padding:4px 8px;text-align:center">Bt</td><td style="padding:4px 8px;text-align:right">Ricavo</td>
        </tr></thead>
        <tbody>${topWines.map(w=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px"><div style="font-size:12px">${h(w.nome)}</div><div style="font-size:11px;color:var(--txt4)">${h(w.produttore)}</div></td><td style="padding:6px 8px">${badge(w.tipologia)}</td><td style="padding:6px 8px;text-align:center;font-family:'Montserrat',sans-serif;color:var(--amber)">${w.bt}</td><td style="padding:6px 8px;text-align:right;color:var(--amber)">${fmt(w.ricavo)}</td></tr>`).join("")}</tbody>
      </table>
    </div>
  </div>`;

  // ── dettaglio movimenti con delete (ex-storico) ──
  const dettaglioHtml = `<div class="card" style="padding:0;margin-bottom:0">
    <div class="tbl-header" style="display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--txt3)">Dettaglio — ${scarichi.length} moviment${scarichi.length===1?'o':'i'}</span>
    </div>
    <div>
      ${scarichi.map(m=>{
        const w=wineMap[m.wineId];
        const ric=calcRicavoMovimento(m,w);
        return `<div class="sc-hist-row" data-mid="${m.id}" style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500;color:var(--txt);word-break:break-word;line-height:1.35">${h(m.wineName||'—')}${w?.annata?` <span style="color:var(--amber);font-size:11px">${h(w.annata)}</span>`:''}</div>
            <div style="font-size:11px;color:var(--txt4);margin-top:2px">${h(m.produttore||w?.produttore||'—')} · ${badge(w?.tipologia||'')} · <span style="color:var(--txt3)">${m.data||'—'}</span>${m.note?` · <span style="font-style:italic">${h(m.note)}</span>`:''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
            <div style="text-align:right">
              <div style="font-family:'Montserrat',sans-serif;font-size:1.1rem;color:#FF6B6B;white-space:nowrap">−${m.qty} bt</div>
              ${ric?`<div style="font-size:11px;color:var(--amber)">${fmt(ric)}</div>`:''}
            </div>
            <button onclick="_eliminaScarico('${m.id}')"
              style="width:34px;height:34px;border-radius:8px;border:1px solid rgba(255,69,58,.3);background:rgba(255,69,58,.1);color:#FF453A;font-size:15px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center"
              title="Elimina scarico e ripristina giacenza">🗑</button>
          </div>
        </div>`;
      }).join("")}
    </div>
    <div style="padding:10px 14px;background:rgba(41,37,36,.3);border-top:1px solid var(--border2);display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--txt3)">Totale</span>
      <div style="display:flex;gap:20px;align-items:center">
        <span style="font-family:'Montserrat',sans-serif;color:#FF6B6B">${totBt} bt</span>
        <span style="color:var(--amber);font-weight:600">${fmt(totRicavo)}</span>
        <span style="color:var(--txt3);font-size:11px">${fmt(totCosto)} costo</span>
      </div>
    </div>
  </div>`;

  return dateSel + kpiHtml + breakdownHtml + dettaglioHtml;
}

function exportReportSerataCSV(data){
  const wineMap=Object.fromEntries(wines.map(w=>[w.id,w]));
  const scarichi=movements.filter(m=>m.tipo==="scarico"&&m.data===data);
  const headers=["Vino","Produttore","Tipologia","Annata","Nazione","Bt","Ricavo","Costo+IVA","Margine","Note"];
  const rows=scarichi.map(m=>{const w=wineMap[m.wineId];const ric=calcRicavoMovimento(m,w);const cos=calcCostoMovimento(m,w);return [m.wineName,m.produttore||"",w?.tipologia||"",w?.annata||"",m.nazione||w?.nazione||"",m.qty,fmtN(ric),fmtN(cos),fmtN(ric-cos),m.note||""];});
  const totRic=scarichi.reduce((s,m)=>s+calcRicavoMovimento(m,wineMap[m.wineId]),0);
  const totCos=scarichi.reduce((s,m)=>s+calcCostoMovimento(m,wineMap[m.wineId]),0);
  rows.push([]);
  rows.push(["","","","","TOTALE",scarichi.reduce((s,m)=>s+m.qty,0),"",fmtN(totRic),fmtN(totCos),fmtN(totRic-totCos),""]);
  dlCSV(toCSV([headers,...rows]),`report_serata_${data}.csv`);
  notify("Serata esportata");
}

function _eliminaScarico(movId){
  const mov=movements.find(m=>m.id===movId);
  if(!mov){notify("Movimento non trovato","err");return;}
  _confirmModal(
    `Eliminare lo scarico di <strong>${mov.qty} bt</strong> — <strong>${h(mov.wineName)}</strong> del ${mov.data}?<br><span style="color:var(--txt3);font-size:11px">La giacenza verrà ripristinata e il FIFO aggiornato.</span>`,
    ()=>{
      // Ripristina giacenza e lotti FIFO
      const wine=wines.find(w=>w.id===mov.wineId);
      if(wine){
        // Ricrea il lotto consumato (approssimazione: aggiunge la qty al lotto più recente)
        const newGiac=(parseInt(wine.giacenza)||0)+mov.qty;
        const lots=(wine.lots||[]).slice();
        // Tenta di trovare il lotto che aveva prezzoAcqLotto uguale e ripristinarlo
        const lotIdx=lots.findIndex(l=>l.prezzoAcq===(mov.prezzoAcqLotto||0)&&l.qtyRimanente<l.qtyCaricata);
        if(lotIdx>=0){
          lots[lotIdx]={...lots[lotIdx],qtyRimanente:(lots[lotIdx].qtyRimanente||0)+mov.qty};
        } else {
          // Fallback: crea micro-lotto di ripristino
          lots.push({id:uid(),data:mov.data,fattura:"",fornitore:mov.fornitore||"",
            prezzoAcq:mov.prezzoAcqLotto||wine.prezzoAcq||0,iva:wine.iva||22,
            qtyCaricata:mov.qty,qtyRimanente:mov.qty,_ripristino:true});
        }
        wines=wines.map(w=>w.id===wine.id?{...w,giacenza:newGiac,lots}:w);
      }
      movements=movements.filter(m=>m.id!==movId);
      scheduleSave();
      clearTimeout(saveTimer);
      _flushSave();
      notify(`✅ Scarico eliminato — giacenza ripristinata`);
      render();
    }
  );
}

function _movTipologiaChange(val){
  movForm._tipologia = val;
  movForm._newTipologia = val;
  _movUpdateCartaPreview();
}


function _movWineMatchSilent(val){
  movForm._wineText=val;
  const v=val.trim().toLowerCase();
  if(!v){movForm.wineId="";movForm._newProduttore="";movForm._tipologia="";movForm._newMode=false;return;}
  // Match esatto sull'etichetta completa con [tipologia]
  let found=wines.find(w=>(w.nome+' — '+w.produttore+(w.annata?' ('+w.annata+')':'')+ ' ['+w.tipologia+']').toLowerCase()===v);
  // Match su nome+produttore+annata senza tipologia
  if(!found) found=wines.find(w=>(w.nome+' — '+w.produttore+(w.annata?' ('+w.annata+')':'')).toLowerCase()===v);
  // Match esatto su nome+produttore (solo se unico)
  if(!found){const candidates=wines.filter(w=>w.nome.toLowerCase()===v||w.nome.toLowerCase()===v.split(' — ')[0].trim());
    if(candidates.length===1) found=candidates[0];
    // se ci sono più annate NON fare match automatico — l'utente deve scegliere dall'elenco
  }
  movForm.wineId=found?found.id:"";
  if(found){ movForm._newProduttore=""; movForm._tipologia=found.tipologia||""; movForm._newMode=false; }
}

function _movWineMatch(val){
  _movWineMatchSilent(val);
}

function _movWineUpdatePanel(){
  render();
  // Auto-focus qty dopo selezione vino — evita click manuale extra
  if(movForm.wineId){
    requestAnimationFrame(()=>{
      const q = document.getElementById('mov-qty-input');
      if(q){ q.focus(); q.select(); }
    });
  }
}

function _movUpdateCartaPreview(){
  const preview = document.getElementById('mov-new-preview');
  const body = document.getElementById('mov-new-preview-body');
  if(!preview||!body) return;
  const nome = (document.querySelector('#mov-wine-input') ? movForm._wineText : movForm._wineText) || '';
  const prod = movForm._newProduttore||'';
  const annata = movForm._newAnnata||'';
  const tipo = movForm._newTipologia||'Rosso';
  const vitigni = movForm._newVitigni||'';
  const zona = movForm._newZona||'';
  const regione = movForm._newRegione||'';
  const pAcq = parseFloat(movForm.prezzoAcqLotto)||0;
  const iva = movForm._newIva||22;
  const pCarta = parseFloat(movForm._newPrezzoCarta)||0;
  const costoIva = pAcq*(1+iva/100);
  const suggerito = pAcq>0 ? Math.ceil(costoIva*_getMolt({prezzoAcq:pAcq,iva,nome,formato:'0.75'})) : null;
  if(!nome&&!prod){ preview.style.display='none'; return; }
  preview.style.display='block';
  body.innerHTML = `
    <div style="font-family:'Montserrat',sans-serif;font-size:1rem;font-weight:600;color:var(--txt)">${h(nome)}${annata?' <span style="color:var(--amber);font-size:.85rem">'+h(annata)+'</span>':''}</div>
    <div style="font-size:11px;color:var(--txt3);margin-top:2px">${h(prod)}${zona?' · <span style="color:var(--txt4)">'+h(zona)+'</span>':''}</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center">
      ${badge(tipo)}
      ${vitigni?`<span style="font-size:10px;color:var(--txt4)">🍇 ${h(vitigni)}</span>`:''}
      ${regione?`<span style="font-size:10px;color:var(--txt3)">${h(regione)}</span>`:''}
    </div>
    ${pAcq>0?`<div style="display:flex;gap:16px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06);font-size:11px">
      <div><span style="color:var(--txt4)">Costo+IVA: </span><span style="color:var(--amber)">${fmt(costoIva)}/bt</span></div>
      <div><span style="color:var(--txt4)">P.Carta: </span><span style="color:${pCarta?'#30D158':'var(--txt4)'}">${pCarta?fmt(pCarta):'—'}</span>${suggerito&&!pCarta?` <span style="color:var(--txt4);font-size:10px">(suggerito: ${fmt(suggerito)})</span>`:''}</div>
      ${pCarta&&costoIva?`<div><span style="color:var(--txt4)">Margine: </span><span style="color:${pCarta-costoIva>=0?'#007AFF':'#FF453A'}">${fmtN((pCarta-costoIva)/pCarta*100,1)}%</span></div>`:''}
    </div>`:''}
  `;
}

function registraMovimento(){
  // Refresh date if the field was left empty (e.g. session crossed midnight)
  if(!movForm.data) movForm.data=today();
  const {tipo,qty,data,fattura,fornitore,note,prezzoAcqLotto}=movForm;
  let {wineId}=movForm;
  const q=parseInt(qty)||0;

  // ── Crea nuova referenza se _newMode è attivo ────────────────────────────
  if(!wineId && movForm._newMode){
    if(tipo==="scarico"){ notify("⚠️ Impossibile scaricare un vino non ancora in cantina","err"); return; }
    const nomeTrimmed=(movForm._wineText||"").trim();
    const prodTrimmed=(movForm._newProduttore||"").trim();
    if(!nomeTrimmed){ notify("⚠️ Inserisci il nome del vino","err"); return; }
    if(!prodTrimmed){ notify("⚠️ Inserisci il produttore","err"); return; }
    const newWine={
      id:uid(), nome:nomeTrimmed, produttore:prodTrimmed,
      distributore:(movForm._newDistributore||fornitore||"").trim(),
      annata:(movForm._newAnnata||"").trim(),
      vitigni:_normVitigni(movForm._newVitigni),
      tipologia:movForm._newTipologia||"Rosso",
      regione:(movForm._newRegione||"").trim(),
      nazione:(movForm._newNazione||"Italia").trim(),
      zona:(movForm._newZona||"").trim(),
      prezzoAcq:parseFloat(prezzoAcqLotto)||0,
      iva:movForm._newIva||22,
      prezzoCarta:parseFloat(movForm._newPrezzoCarta)||0,
      giacenza:0, lots:[]
    };
    newWine.nazione = inferPaese(newWine.nazione, newWine.regione, newWine.zona) || newWine.nazione || "Italia";
    wines=[...wines, newWine];
    wineId=newWine.id;
    notify("🆕 Nuova referenza creata: "+nomeTrimmed+(newWine.annata?" "+newWine.annata:""));
  } else if(!wineId){
    const nomeTrimmed=(movForm._wineText||"").trim();
    if(!nomeTrimmed){ notify("⚠️ Seleziona un vino dall'elenco","err"); return; }
    notify("⚠️ Vino non trovato — clicca 'Crea nuova referenza' per aggiungerlo","err"); return;
  }

  if(q<=0){notify("⚠️ Inserisci una quantità valida","err");return}
  const wine=wines.find(w=>w.id===wineId);
  if(!wine){notify("⚠️ Vino non trovato","err");return;}
  if(tipo==="scarico"&&wine.giacenza<q){notify(`Giacenza insufficiente (${wine.giacenza} disponibili)`,"err");return}
  wines=wines.map(w=>{
    if(w.id!==wineId) return w;
    if(tipo==="carico"){
      const pAcq=parseFloat(prezzoAcqLotto)||parseFloat(w.prezzoAcq)||0;
      const newLot={id:uid(),data,fattura,fornitore,prezzoAcq:pAcq,iva:w.iva,qtyCaricata:q,qtyRimanente:q};
      const wTracked=_trackPriceChange(w, pAcq, null, 'carico');
      return{...wTracked,giacenza:w.giacenza+q,prezzoAcq:pAcq||w.prezzoAcq,lots:[...(w.lots||[]),newLot]};
    } else {
      let rem=q;
      const updLots=(w.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c}});
      return{...w,giacenza:w.giacenza-q,lots:updLots};
    }
  });
  // M7: snapshot del costo medio ponderato al momento dello scarico
  const _costoSnap = tipo==="scarico" ? calcCostoIvaBottiglia(wine) : undefined;
  const _movEntry = {id:uid(),wineId,wineName:wine.nome,produttore:wine.produttore,nazione:wine.nazione||"",tipo,qty:q,data,fattura,fornitore,note,ts:Date.now()};
  if(_costoSnap) _movEntry.costoUnitarioIva = _costoSnap;
  movements=[_movEntry,...movements];
  movForm={...movForm,wineId:"",_wineText:"",_newProduttore:"",_newTipologia:"Rosso",_newPrezzoCarta:"",_newVitigni:"",_newZona:"",_newAnnata:"",_newRegione:"",_newNazione:"Italia",_newIva:22,_newDistributore:"",_tipologia:"",_newMode:false,qty:1,fattura:"",fornitore:"",note:"",prezzoAcqLotto:""};
  scheduleSave();
  // PATCH: flush immediato per carichi/scarichi — modificano giacenza
  clearTimeout(saveTimer); _flushSave();
  notify(tipo==="carico"?"📦 Carico registrato":"🍾 Scarico registrato"); if(section==="inventario") renderInventarioOnly(); else render();
}

// ─── FALLATE ─────────────────────────────────────────────────────────────────
function renderFallate(){
  let html=`<div class="kpi-grid g2" style="margin-bottom:20px">
    <div class="card">
      <div class="section-label"><span>⚠️ Registra Bottiglia Fallata</span></div>
      <div class="form-row"><label class="form-label">Vino</label>
        <select class="form-select" onchange="fallForm.wineId=this.value;render()">
          <option value="">— Seleziona vino —</option>
          ${wines.filter(w=>w.giacenza>0).map(w=>`<option value="${w.id}" ${fallForm.wineId===w.id?"selected":""}>${h(w.nome)} — ${h(w.produttore)} · ${w.giacenza}bt</option>`).join("")}
        </select>
      </div>
      <div class="form-grid g2">
        <div><label class="form-label">Quantità</label><input class="form-input" type="number" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" value="${fallForm.qty}" oninput="fallForm.qty=this.value"></div>
        <div><label class="form-label">Data</label><input class="form-input" type="date" value="${fallForm.data}" oninput="fallForm.data=this.value"></div>
      </div>
      <div class="form-row" style="margin-top:10px"><label class="form-label">Motivo</label>
        <select class="form-select" onchange="fallForm.motivo=this.value">
          ${FALLATA_MOTIVI.map(m=>`<option ${fallForm.motivo===m?"selected":""}>${h(m)}</option>`).join("")}
        </select>
      </div>
      <div class="form-row" style="margin-top:10px"><label class="form-label">Note</label><input class="form-input" value="${h(fallForm.note)}" placeholder="Note aggiuntive…" oninput="fallForm.note=this.value"></div>
      <button class="btn-primary" style="background:var(--amber3);width:100%;justify-content:center;margin-top:14px" onclick="registraFallata()">⚠️ Registra Fallata</button>
    </div>
    <div class="card">
      <div class="section-label"><span>📋 Log Recenti</span></div>
      <div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
        ${fallate.length===0?`<div style="text-align:center;padding:28px;color:var(--txt4);font-size:11px">Nessuna fallata registrata</div>`:
        fallate.slice(0,10).map(f=>`<div class="fallate-log"><span style="color:#fb923c">⚠</span><div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(f.wineName)}</div><div style="color:var(--txt4);font-size:10px">${f.data} · ${h(f.motivo)}</div></div><span style="font-family:'Montserrat',sans-serif;color:#fb923c;font-size:1rem">${f.qty}bt</span></div>`).join("")}
      </div>
    </div>
  </div>
  <div class="card" style="padding:0">
    <div class="tbl-header"><span style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt3)">Registro Completo — ${fallate.length} fallate</span><button class="btn-outline btn-sm" onclick="exportFallateCSV()">↓ CSV</button></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Data</th><th>Vino</th><th>Produttore</th><th>Nazione</th><th>Motivo</th><th class="r">Qtà</th><th>Note</th></tr></thead>
      <tbody>
        ${fallate.length===0?`<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--txt4)">Nessuna fallata</td></tr>`:
        (()=>{ const wMap=Object.fromEntries(wines.map(w=>[w.id,w])); return fallate.map(f=>{const wF=wMap[f.wineId];return`<tr><td style="color:var(--txt2)">${h(f.data)}</td><td>${h(f.wineName)}</td><td style="color:var(--txt2)">${h(f.produttore||"—")}</td><td style="color:var(--amber3);font-size:10px">${h(wF?.nazione||"—")}</td><td style="color:var(--txt3)">${h(f.motivo)}</td><td class="r" style="color:#fb923c;font-family:'Montserrat',sans-serif">${f.qty}</td><td style="color:var(--txt4);font-size:10px">${h(f.note||"—")}</td></tr>`}).join(""); })()}
      </tbody>
    </table></div>
  </div>`;
  return html;
}

function registraFallata(){
  const {wineId,qty,motivo,data,note}=fallForm;
  const q=parseInt(qty)||0;
  if(!wineId||q<=0){notify("Seleziona un vino e inserisci la quantità","err");return}
  if(data > today()){notify("⚠️ La data non può essere nel futuro","err");return}
  const wine=wines.find(w=>w.id===wineId);
  if(!wine){notify("⚠️ Vino non trovato","err");return;}
  if(wine.giacenza<q){notify(`Giacenza insufficiente (${wine.giacenza} disponibili)`,"err");return}
  wines=wines.map(w=>{
    if(w.id!==wineId) return w;
    let rem=q;
    const updLots=(w.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c}});
    return{...w,giacenza:w.giacenza-q,lots:updLots};
  });
  fallate=[{id:uid(),wineId,wineName:wine.nome,produttore:wine.produttore,qty:q,motivo,data,note,ts:Date.now()},...fallate];
  fallForm={...fallForm,qty:1,note:""};
  scheduleSave();
  // PATCH: flush immediato per fallate — modificano giacenza
  clearTimeout(saveTimer); _flushSave();
  notify("⚠️ Fallata registrata, giacenza aggiornata"); if(section==="inventario") renderInventarioOnly(); else render();
}

// ─── ANALYTICS ───────────────────────────────────────────────────────────────
function _buildComboOpts(items, inputId, listId){
  return `<input id="${inputId}" class="form-input" list="${listId}" autocomplete="off" style="width:100%" placeholder="Scrivi o scegli…">
<datalist id="${listId}">${[...new Set(items.filter(Boolean))].sort().map(v=>`<option value="${h(v)}">`).join("")}</datalist>`;
}

function renderOrdini(){
  // Compute unique dropdown lists from existing wines + past orders
  const allFornitori=[...new Set([...wines.map(w=>w.distributore),...orders.map(o=>o.fornitore)].filter(Boolean))].sort();
  const allProduttori=[...new Set([...wines.map(w=>w.produttore),...orders.flatMap(o=>(o.referenze||[]).map(r=>r.produttore))].filter(Boolean))].sort();
  const allNomiVino=[...new Set(wines.map(w=>w.nome).filter(Boolean))].sort();

  // Active orders (not fully loaded) — include bozze remote da ordini_testata
  const _bozzeLocali=_bozzeSb.filter(b=>!orders.some(o=>o._sbTestataId===b.id));
  const ordiniAttivi=[..._bozzeLocali.map(b=>({
    id:b.id, _sbTestataId:b.id, fornitore:b.distributore,
    dataOrdine:b.data_ordine||today(), note:b.note||'',
    stato:'attesa', referenze:(b.righe||[]).map(r=>({
      id:r.id, wineId:r.wine_id, nomeVino:r.nome_vino||'', produttore:r.produttore||'',
      annata:r.annata||'', tipologia:'', prezzoAcq:r.prezzo_acq||0,
      iva:r.iva||22, qty:r.qty_ordinata||1, formato:r.formato||0.75,
      regione:'', zona:'', nazione:'', prezzoCarta:''
    })), _isBozzaSb:true
  })),...orders.filter(o=>o.stato!=="caricato")];
  const ordiniAttesa=ordiniAttivi.filter(o=>o.stato==="attesa");

  const ordiniRows=ordiniAttivi.length ? ordiniAttivi.map(o=>{
    const ref=o.referenze||[];
    const totQty=ref.reduce((s,r)=>s+(parseInt(r.qty)||0),0);
    const totLordo=ref.reduce((s,r)=>{const p=parseFloat(r.prezzoAcq)||0;const iva=(parseInt(r.iva)||22)/100;return s+p*(1+iva)*(parseInt(r.qty)||0);},0);
    const _sconto=parseFloat(o.sconto)||0;
    const totNetto=totLordo*(1-_sconto/100);
    const valCell=_sconto>0
      ? `<span style="color:var(--txt4);text-decoration:line-through;font-size:10px">${fmt(totLordo)}</span> <span style="color:#30D158;font-weight:600">${fmt(totNetto)}</span> <span style="font-size:9px;color:#FF453A">−${_sconto}%</span>`
      : fmt(totLordo);
    const isPending=o.stato==="confermato_pendente";
    const statoCell=isPending
      ? `<span style="display:inline-flex;align-items:center;gap:4px;background:#16a34a22;color:#30D158;border:1px solid #16a34a55;padding:2px 8px;font-size:.75rem;font-weight:600">✔ Ricevuto</span>`
      : `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--amber3)22;color:var(--amber);border:1px solid var(--amber3)55;padding:2px 8px;font-size:.75rem;font-weight:600">⏳ In attesa</span>`;
    const invBadge = o.inviatoVia
      ? (o.inviatoVia==='email'     ? `<span title="Inviato via email il ${o.dataInvio||'—'}" style="display:inline-flex;align-items:center;gap:3px;background:rgba(255,159,10,.12);color:var(--amber);border:1px solid rgba(255,159,10,.3);padding:2px 7px;font-size:.7rem;font-weight:600;border-radius:5px">✉️ Inviato</span>`
        : o.inviatoVia==='whatsapp' ? `<span title="Inviato via WhatsApp il ${o.dataInvio||'—'}" style="display:inline-flex;align-items:center;gap:3px;background:rgba(37,211,102,.1);color:#25D366;border:1px solid rgba(37,211,102,.3);padding:2px 7px;font-size:.7rem;font-weight:600;border-radius:5px">🟢 Inviato</span>`
        : `<span title="Inviato via email e WhatsApp il ${o.dataInvio||'—'}" style="display:inline-flex;align-items:center;gap:3px;background:rgba(0,122,255,.1);color:#007AFF;border:1px solid rgba(0,122,255,.3);padding:2px 7px;font-size:.7rem;font-weight:600;border-radius:5px">📨 Inviato</span>`)
      : `<span style="display:inline-flex;align-items:center;gap:3px;background:rgba(142,142,147,.1);color:var(--txt4);border:1px solid rgba(142,142,147,.2);padding:2px 7px;font-size:.7rem;font-weight:600;border-radius:5px">📋 Bozza</span>`;
    return `<tr id="ord-row-${o.id}" class="${isPending?'lot-active':''}" data-sel-id="${o.id}">
      ${selMode==='ordini'?`<td class="cb-col"><input type="checkbox" class="cb-sel" data-id="${o.id}" onchange="toggleSel('${o.id}');_updateBulkBar()"></td>`:''}
      <td><input type="checkbox" class="ord-check" data-id="${o.id}" ${isPending?'checked':''} onchange="toggleOrdineArrivato('${o.id}',this.checked)" style="width:18px;height:18px;cursor:pointer"></td>
      <td>${h(o.dataOrdine)}</td>
      <td style="font-weight:500">${h(o.fornitore||'—')}</td>
      <td style="color:var(--txt3);font-size:10px">${ref.length} ref.</td>
      <td style="color:var(--amber)">${totQty} bt</td>
      <td style="color:var(--txt2)">${valCell}</td>
      <td><input type="date" class="form-input" style="font-size:10px;padding:3px 6px;width:130px;background:${o.dataArrivo?'rgba(48,209,88,.06)':'rgba(255,159,10,.06)'};border-color:${o.dataArrivo?'rgba(48,209,88,.25)':'rgba(255,159,10,.2)'}" value="${o.dataArrivo||''}" placeholder="—" title="Data arrivo prevista" onchange="orders.find(x=>x.id==='${o.id}').dataArrivo=this.value;scheduleSave();notify('📅 Data arrivo aggiornata')"></td>
      <td><div style="display:flex;flex-direction:column;gap:4px">${statoCell}${invBadge}</div></td>
      <td style="display:flex;gap:6px;align-items:center;padding:6px 14px">
        <button class="btn-outline btn-sm" onclick="apriModalRicezione('${o.id}')" title="Conferma arrivo" style="border-color:rgba(22,163,74,.4);color:#30D158">📦 Ricevi</button>
        <button class="btn-outline btn-sm" onclick="apriOrdineModal('${o.id}')" title="Modifica ordine">✏️</button>
        <button class="btn-outline btn-sm" onclick="stampaOrdine('${o.id}')" title="Stampa / Salva PDF" style="border-color:rgba(0,122,255,.3);color:#007AFF">🖨️</button>
        <button class="btn-outline btn-sm" onclick="emailOrdine('${o.id}')" title="Invia via email" style="border-color:rgba(255,159,10,.3);color:var(--amber)">✉️</button>
        <button class="btn-outline btn-sm" onclick="whatsappOrdine('${o.id}')" title="Invia su WhatsApp" style="border-color:rgba(37,211,102,.3);color:#25D366">🟢</button>
        <button class="btn-icon" onclick="deleteOrdine('${o.id}')" title="Elimina" style="color:var(--txt4);font-size:14px">🗑️</button>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="8" style="text-align:center;color:var(--txt4);padding:24px">Nessun ordine aperto</td></tr>`;

  // Historic orders
  const evasi=orders.filter(o=>o.stato==="caricato").sort((a,b)=>(b.dataCarico||b.dataArrivo||"").localeCompare(a.dataCarico||a.dataArrivo||""));
  const q=storicoQ.toLowerCase().trim();
  const filteredEvasi=evasi.filter(o=>{
    const testo=[o.fornitore,...(o.referenze||[]).map(r=>r.nomeVino+r.produttore)].join(" ").toLowerCase();
    if(q&&!testo.includes(q)) return false;
    if(storicoForn&&o.fornitore!==storicoForn) return false;
    if(storicoDataDa&&(o.dataArrivo||o.dataOrdine||"")<storicoDataDa) return false;
    if(storicoDataA&&(o.dataArrivo||o.dataOrdine||"")>storicoDataA) return false;
    return true;
  });
  const fornEvasi=[...new Set(evasi.map(o=>o.fornitore).filter(Boolean))].sort();
  const righeEvasi=filteredEvasi.map(o=>{
    const ref=o.referenze||[];
    const totQty=ref.reduce((s,r)=>s+(parseInt(r.qtyArr??r.qty)||0),0);
    return `<tr>
      <td style="padding:6px 8px;text-align:center"><input type="checkbox" class="cb-sel evaso-check" data-id="${o.id}" style="width:13px;height:13px;accent-color:var(--amber);cursor:pointer"></td>
      <td style="color:var(--txt3);font-size:.8rem">${h(o.dataOrdine)}</td>
      <td style="font-weight:500">${h(o.fornitore||'—')}</td>
      <td style="color:var(--txt3)">${ref.length} referenze</td>
      <td style="color:var(--txt2)">${totQty} bt</td>
      <td style="color:var(--txt3);font-size:.8rem">${h(o.dataArrivo)||"—"}</td>
      <td style="color:var(--amber);font-size:.8rem">
        <span id="fatt-val-${o.id}" style="cursor:pointer" title="Clicca per modificare" onclick="editFattura('${o.id}')">${h(o.numeroFattura||o.fattura)||'<span style="color:var(--txt4)">— modifica</span>'}</span>
        <input id="fatt-inp-${o.id}" class="form-input" style="display:none;width:120px;font-size:11px;padding:2px 6px" value="${h(o.numeroFattura||o.fattura||'')}" placeholder="Es. FT-2025-001"
          onblur="saveFattura('${o.id}',this.value)"
          onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value=orders.find(x=>x.id==='${o.id}')?.numeroFattura||'';this.blur()}">
      </td>
      <td style="color:var(--txt4);font-size:.75rem">${h(o.dataCarico)||"—"}</td>
      <td style="white-space:nowrap">
        <button class="btn-outline btn-sm" onclick="mostraDettaglioOrdine('${o.id}')" style="font-size:9px;padding:2px 8px;color:var(--txt4)">dettaglio</button>
        <button class="btn-outline btn-sm" onclick="apriOrdineEvasoModal('${o.id}')" style="font-size:9px;padding:2px 8px;color:var(--amber);border-color:rgba(255,159,10,.25)">✏️</button>
        <button onclick="deleteEvaso('${o.id}')" style="color:#FF453A;font-size:12px;background:none;border:none;cursor:pointer;margin-left:4px;padding:2px 4px" title="Elimina ordine evaso">🗑️</button>
      </td>
    </tr>
    <tr id="det-${o.id}" class="hidden" style="background:rgba(28,28,30,.6)">
      <td colspan="9" style="padding:0 14px 10px">
        <table style="width:100%;font-size:10px;border-collapse:collapse">
          <tr style="color:var(--txt4)">${["Produttore","Vino","Annata","Vitigni","Tipo","Ord.","Arriv.","P.Acq"].map(c=>`<td style="padding:4px 8px">${c}</td>`).join("")}</tr>
          ${ref.map(r=>`<tr style="border-top:1px solid var(--border)">
            <td style="padding:4px 8px;color:var(--txt3)">${h(r.produttore||'—')}</td>
            <td style="padding:4px 8px">${h(r.nomeVino)}</td>
            <td style="padding:4px 8px;color:var(--amber);font-family:'Montserrat',sans-serif;font-size:10px;text-align:center">${r.annata?h(r.annata):'<span style="color:var(--txt4)">N.V.</span>'}</td>
            <td style="padding:4px 8px;color:var(--txt3);font-size:10px">${h(r.vitigni||'—')}</td>
            <td style="padding:4px 8px">${badge(r.tipologia)}</td>
            <td style="padding:4px 8px;color:var(--txt2)">${r.qty}</td>
            <td style="padding:4px 8px;color:${(r.qtyArr!==undefined&&r.qtyArr!==r.qty)?"#fb923c":"#30D158"}">${r.qtyArr??r.qty}</td>
            <td style="padding:4px 8px;color:var(--amber)">${fmtN(r.prezzoAcq)}</td>
          </tr>`).join("")}
        </table>
      </td>
    </tr>`;
  }).join("");

  return `
  <!-- Datalists globali -->
  <datalist id="dl-fornitori">${allFornitori.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
  <datalist id="dl-produttori">${allProduttori.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
  <datalist id="dl-wine-names">${allNomiVino.map(v=>`<option value="${h(v)}">`).join("")}</datalist>

  <!-- Header nuovo ordine -->
  <div class="card" style="margin-bottom:16px">
    ${selMode==='ordini'?renderBulkBar('ordini', ordiniAttivi.map(o=>o.id)):''}
    <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
      <span>📋 Ordini Fornitore (${ordiniAttivi.length} aperti, ${ordiniAttesa.length} in attesa)</span>
      <div style="display:flex;gap:8px">
        ${selMode!=='ordini'?`<button class="btn-outline btn-sm" onclick="enterSel('ordini')" style="border-color:rgba(59,130,246,.5);color:#93c5fd">☑ Selezione multipla</button>`:''}
        <button class="btn-outline btn-sm" onclick="_pulisciDateOrdiniImportati()" title="Rimuove date arrivo/carico errate dagli ordini importati" style="border-color:rgba(255,69,58,.3);color:#FF453A;font-size:9px">🧹 Pulisci date import</button>
        <button class="btn-primary" onclick="apriOrdineModal(null)">➕ Nuovo Ordine</button>
      </div>
    </div>
    <div style="overflow-x:auto">
      <table class="wine-table">
        <thead><tr>
          ${selMode==='ordini'?`<th class="cb-col"><input type="checkbox" id="cb-sel-all" class="cb-sel" onchange="toggleSelAll()"></th>`:''}
          <th style="width:36px"></th>
          <th>Data Ordine</th><th>Fornitore</th><th>Referenze</th><th>Tot. Bottiglie</th><th>Valore stimato</th>
          <th>Data Arrivo</th><th>Stato</th><th></th>
        </tr></thead>
        <tbody>${ordiniRows}</tbody>
      </table>
    </div>
    <div style="padding:12px 16px;display:flex;justify-content:flex-end">
      <button class="btn-primary" onclick="apriModalRicezioneGlobale()" style="background:linear-gradient(135deg,#16a34a,#15803d);gap:8px;display:flex;align-items:center">
        ✅ Conferma Ricezione Multipla
      </button>
    </div>
  </div>

  <!-- Modal Nuovo/Modifica Ordine -->
  <div id="ordine-modal-backdrop" class="modal-backdrop hidden" onclick="chiudiOrdineModal(event)">
    <div class="modal" style="width:94vw;max-width:1500px" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2 id="ordine-modal-title">➕ Nuovo Ordine</h2>
        <button style="font-size:18px;color:var(--txt3)" onclick="chiudiOrdineModal()">✕</button>
      </div>
      <div class="modal-body" id="ordine-modal-body"></div>
      <div class="modal-footer">
        <button class="btn-outline" onclick="chiudiOrdineModal()">Annulla</button>
        <button class="btn-outline" onclick="stampaOrdine(ordineModalData?.id)" title="Stampa / Salva PDF" style="border-color:rgba(0,122,255,.3);color:#007AFF">🖨️ Stampa / PDF</button>
        <button class="btn-outline" onclick="emailOrdine(ordineModalData?.id)" title="Invia via email" style="border-color:rgba(255,159,10,.3);color:var(--amber)">✉️ Email fornitore</button>
        <button class="btn-outline" onclick="whatsappOrdine(ordineModalData?.id)" title="Invia su WhatsApp" style="border-color:rgba(37,211,102,.3);color:#25D366">🟢 WhatsApp</button>
        <button class="btn-primary" onclick="salvaOrdine()">💾 Salva Ordine</button>
      </div>
    </div>
  </div>

  <!-- Modal Ricezione Singola Ordine -->
  <div id="ricezione-modal-backdrop" class="modal-backdrop hidden" onclick="chiudiRicezioneModal(event)">
    <div class="modal" style="max-width:820px" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>📦 Conferma Arrivo Ordine</h2>
        <button style="font-size:18px;color:var(--txt3)" onclick="chiudiRicezioneModal()">✕</button>
      </div>
      <div class="modal-body" id="ricezione-modal-body"></div>
      <div class="modal-footer">
        <button class="btn-outline" onclick="chiudiRicezioneModal()">Annulla</button>
        <button class="btn-primary" onclick="confermaRicezioneOrdine()" style="background:linear-gradient(135deg,#16a34a,#15803d)">✅ Carica in Magazzino</button>
      </div>
    </div>
  </div>

  <!-- Modal Ricezione Globale (multipla) -->
  <div id="ricezione-globale-backdrop" class="modal-backdrop hidden" onclick="chiudiRicezioneGlobale(event)">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>📦 Conferma Ricezione Multipla</h2>
        <button style="font-size:18px;color:var(--txt3)" onclick="chiudiRicezioneGlobale()">✕</button>
      </div>
      <div class="modal-body">
        <p style="color:var(--txt3);margin-bottom:16px;font-size:.9rem">Verranno processati gli ordini con la spunta attiva. Per modificare quantità o aggiungere referenze usa "📦 Ricevi" sul singolo ordine.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div><label class="form-label">Data Arrivo</label><input id="ric-glob-data" type="date" class="form-input" value="${today()}"></div>
          <div><label class="form-label">Numero Fattura <span style="color:var(--txt4)">(opzionale)</span></label><input id="ric-glob-fattura" type="text" class="form-input" placeholder="Es. FT-2025-001"></div>
        </div>
        <div id="ric-glob-preview" style="background:var(--bg3);border:1px solid var(--border);padding:12px;font-size:.85rem;color:var(--txt3);max-height:300px;overflow-y:auto"></div>
      </div>
      <div class="modal-footer">
        <button class="btn-outline" onclick="chiudiRicezioneGlobale()">Annulla</button>
        <button class="btn-primary" onclick="confermaRicezioneGlobale()" style="background:linear-gradient(135deg,#16a34a,#15803d)">✅ Conferma Tutti</button>
      </div>
    </div>
  </div>

  ${evasi.length ? `
  <div class="card" style="margin-top:20px;border-color:rgba(68,64,60,.4)">
    <div class="card-header" style="background:rgba(41,37,36,.5);flex-wrap:wrap;gap:8px">
      <span style="color:var(--txt3)">📁 Storico Ordini Evasi (${evasi.length}${filteredEvasi.length!==evasi.length?` · ${filteredEvasi.length} mostrati`:""})</span>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn-danger btn-sm" onclick="deleteEvasiSelezionati()" style="font-size:9px;padding:3px 10px">🗑️ Elimina selezionati</button>
        <button class="btn-outline btn-sm" onclick="exportStoricoOrdiniCSV()" style="color:var(--txt3);border-color:var(--border)">↓ CSV</button>
      </div>
    </div>
    <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
      <div class="search-wrap" style="flex:1;min-width:160px"><span class="search-icon">🔍</span><input class="form-input" style="padding-left:28px;font-size:11px" placeholder="Cerca vino, fornitore…" value="${h(storicoQ)}" oninput="storicoQ=this.value;render()"></div>
      <div style="min-width:140px"><select class="form-select" style="font-size:11px" onchange="storicoForn=this.value;render()">
        <option value="">Tutti i fornitori</option>
        ${fornEvasi.map(f=>`<option value="${h(f)}" ${storicoForn===f?"selected":""}>${h(f)}</option>`).join("")}
      </select></div>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="date" class="form-input" style="font-size:11px;width:130px" value="${storicoDataDa}" onchange="storicoDataDa=this.value;render()">
        <span style="color:var(--txt4);font-size:10px">→</span>
        <input type="date" class="form-input" style="font-size:11px;width:130px" value="${storicoDataA}" onchange="storicoDataA=this.value;render()">
      </div>
      ${(storicoQ||storicoForn||storicoDataDa||storicoDataA)?`<button class="btn-outline btn-sm" onclick="storicoQ='';storicoForn='';storicoDataDa='';storicoDataA='';render()" style="color:var(--txt4)">✕ Reset</button>`:""}
    </div>
    <div style="overflow-x:auto">
      <table class="wine-table" style="opacity:.85">
        <thead><tr><th style="width:32px"></th><th>Data Ordine</th><th>Fornitore</th><th>Referenze</th><th>Bottiglie</th><th>Data Arrivo</th><th>Proforma/Fattura</th><th>Caricato il</th><th></th></tr></thead>
        <tbody>${filteredEvasi.length?righeEvasi:`<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--txt4);font-size:11px">Nessun risultato</td></tr>`}</tbody>
      </table>
    </div>
  </div>` : ""}

  <!-- MODAL MODIFICA ORDINE EVASO -->
  <div class="modal-backdrop hidden" id="ordine-evaso-modal-backdrop" onclick="chiudiOrdineEvasoModal(event)">
    <div class="modal" style="max-width:820px" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>✏️ Modifica Ordine Evaso</h2>
        <button style="font-size:18px;color:var(--txt3)" onclick="chiudiOrdineEvasoModal()">✕</button>
      </div>
      <div class="modal-body" id="ordine-evaso-modal-body"></div>
      <div class="modal-footer">
        <button class="btn-outline" onclick="chiudiOrdineEvasoModal()">Annulla</button>
        <button class="btn-primary" onclick="salvaOrdineEvaso()">💾 Salva Modifiche</button>
      </div>
    </div>
  </div>`;
}

function editFattura(id){
  document.getElementById("fatt-val-"+id).style.display="none";
  const inp=document.getElementById("fatt-inp-"+id);
  inp.style.display="inline-block";inp.focus();inp.select();
}
function saveFattura(id,val){
  const o=orders.find(x=>x.id===id);
  if(o){o.numeroFattura=val.trim();scheduleSave();}
  const span=document.getElementById("fatt-val-"+id);
  if(span){span.innerHTML=val.trim()||'<span style="color:var(--txt4)">— modifica</span>';span.style.display="";}
  const inp=document.getElementById("fatt-inp-"+id);
  if(inp) inp.style.display="none";
}
function mostraDettaglioOrdine(id){
  const el=document.getElementById("det-"+id);
  if(el) el.classList.toggle("hidden");
}
function _setQuickCarta(wineId){
  const val=parseFloat(document.getElementById("mov-quick-carta")?.value)||0;
  if(!val){notify("⚠️ Inserisci un prezzo valido","err");return;}
  wines=wines.map(w=>{
    if(w.id!==wineId) return w;
    const wt=_trackPriceChange(w, null, val, 'carta_rapida');
    return {...wt, prezzoCarta:val};
  });
  scheduleSave(); notify(`✅ Prezzo carta aggiornato: ${fmt(val)}`); render();
}

function _rollbackOrdine(ordine){
  // Find and remove movements created from this order
  const notePattern="Da ordine "+ordine.dataOrdine;
  const movsDaRimuovere=movements.filter(m=>m.note===notePattern&&m.tipo==="carico"&&m.fornitore===ordine.fornitore);
  const movsIds=new Set(movsDaRimuovere.map(m=>m.id));
  // For each referenza, decrement giacenza and remove lot
  // FIX FORMATO: match per wineId quando disponibile, con fallback nome+formato
  // (evita di scalare la voce sbagliata quando esistono più formati dello stesso vino)
  (ordine.referenze||[]).forEach(r=>{
    const rFmt=String(parseFloat(r.formato)||0.75);
    const sameFmt=w=>String(parseFloat(w.formato)||0.75)===rFmt;
    const sameAnnata=w=>(w.annata||"").toLowerCase().trim()===(r.annata||"").toLowerCase().trim();
    // Cerca per wineId con validazione annata (stesso fix di confermaRicezioneOrdine)
    let wine = r.wineId ? wines.find(w=>w.id===r.wineId&&sameFmt(w)&&sameAnnata(w)) : null;
    // fallback NV: se non ha annata, il wineId è affidabile senza check annata
    if(!wine && r.wineId && !(r.annata||"").trim()) wine = wines.find(w=>w.id===r.wineId&&sameFmt(w));
    // fallback nome+produttore+annata
    if(!wine){
      const nn=r.nomeVino.toLowerCase(), rp=(r.produttore||"").toLowerCase(), ra=(r.annata||"").toLowerCase().trim();
      if(ra) wine=wines.find(w=>w.nome.toLowerCase()===nn&&(w.produttore||"").toLowerCase()===rp&&(w.annata||"").toLowerCase().trim()===ra&&sameFmt(w));
      else wine=wines.find(w=>w.nome.toLowerCase()===nn&&(w.produttore||"").toLowerCase()===rp&&sameFmt(w));
    }
    if(!wine) return;
    const qtyToRemove=parseInt(r.qtyArr??r.qty)||0;
    if(!qtyToRemove) return;
    const newGiac=Math.max(0,(parseInt(wine.giacenza)||0)-qtyToRemove);
    // Remove the lot linked to this order (match by fattura+data+qty)
    const newLots=(wine.lots||[]).filter(l=>!(l.fattura===(ordine.numeroFattura||ordine.fattura||"")&&l.data===ordine.dataArrivo&&l.qtyCaricata===qtyToRemove));
    wines=wines.map(w=>w.id===wine.id?{...w,giacenza:newGiac,lots:newLots}:w);
  });
  movements=movements.filter(m=>!movsIds.has(m.id));
}

function deleteEvaso(id){
  const o=orders.find(x=>x.id===id);
  if(!o) return;
  const totQty=(o.referenze||[]).reduce((s,r)=>s+(parseInt(r.qtyArr??r.qty)||0),0);
  _confirmModal2(
    `Eliminare l'ordine <strong>${o.fornitore||'—'}</strong> del ${o.dataOrdine||'—'}?`,
    { label:`🔄 Annulla carico (−${totQty} bt)`, cb:()=>{ _rollbackOrdine(o); orders=orders.filter(x=>x.id!==id); scheduleSave(); clearTimeout(saveTimer); _flushSave(); notify(`🗑️ Ordine e carico annullati (−${totQty} bt)`); render(); } },
    { label:"🗑️ Solo storico",                  cb:()=>{ orders=orders.filter(x=>x.id!==id); scheduleSave(); clearTimeout(saveTimer); _flushSave(); notify("🗑️ Ordine rimosso dallo storico"); render(); } }
  );
}

function deleteEvasiSelezionati(){
  const checked=[...document.querySelectorAll(".evaso-check:checked")].map(cb=>cb.dataset.id);
  if(!checked.length){notify("⚠️ Seleziona almeno un ordine","err");return;}
  const selOrdini=orders.filter(o=>checked.includes(o.id));
  const totQty=selOrdini.reduce((s,o)=>(o.referenze||[]).reduce((s2,r)=>s2+(parseInt(r.qtyArr??r.qty)||0),s),0);
  const ids=new Set(checked);
  _confirmModal2(
    `Eliminare <strong>${checked.length} ordin${checked.length===1?'e':'i'}</strong>?`,
    { label:`🔄 Annulla carichi (−${totQty} bt)`, cb:()=>{ selOrdini.forEach(o=>_rollbackOrdine(o)); orders=orders.filter(o=>!ids.has(o.id)); scheduleSave(); notify(`🗑️ ${checked.length} ordini e carichi annullati`); render(); } },
    { label:"🗑️ Solo storico",                   cb:()=>{ orders=orders.filter(o=>!ids.has(o.id)); scheduleSave(); notify(`🗑️ ${checked.length} ordini rimossi`); render(); } }
  );
}

// ── MODAL MODIFICA ORDINE EVASO ───────────────────────────────────────────────
let _editOrdineEvasoId = null;

function apriOrdineEvasoModal(id){
  const o = orders.find(x => x.id === id);
  if(!o){ notify("Ordine non trovato","err"); return; }
  _editOrdineEvasoId = id;

  const allFornitori=[...new Set([...wines.map(w=>w.distributore),...orders.map(x=>x.fornitore)].filter(Boolean))].sort();
  const TIPOLOGIE_OPTS = _tipoOptsHtml("");
  const IVA_OPTS = IVA_OPTIONS.map(v=>`<option value="${v}">${v}%</option>`).join("");

  const refsHtml = (o.referenze||[]).map((r,i)=>`
    <tr data-evaso-ref-id="${r.id}" style="border-top:1px solid var(--border)">
      <td style="padding:5px 8px"><input class="form-input" style="font-size:11px" value="${h(r.produttore||'')}" placeholder="Produttore"></td>
      <td style="padding:5px 8px"><input class="form-input" style="font-size:11px" value="${h(r.nomeVino||'')}" placeholder="Nome vino"></td>
      <td style="padding:5px 8px"><input class="form-input" style="font-size:11px;width:80px" value="${h(r.annata||'')}" placeholder="Anno"></td>
      <td style="padding:5px 8px"><select class="form-select" style="font-size:11px" data-prev="${h(r.tipologia)}" onchange="_addTipologiaInline(this);if(this.value!=='__new__')this.dataset.prev=this.value">${_tipoOptsHtml(r.tipologia)}</select></td>
      <td style="padding:5px 8px;text-align:center"><input type="number" class="form-input" style="font-size:11px;width:60px;text-align:center" value="${r.qty||0}" min="0"></td>
      <td style="padding:5px 8px;text-align:center"><input type="number" class="form-input" style="font-size:11px;width:60px;text-align:center" value="${r.qtyArr??r.qty??0}" min="0"></td>
      <td style="padding:5px 8px"><input type="number" class="form-input" style="font-size:11px;width:80px" value="${r.prezzoAcq||''}" step="0.01" min="0" placeholder="0.00"></td>
      <td style="padding:5px 8px;text-align:center"><button onclick="this.closest('tr').remove()" style="background:none;border:none;color:#FF453A;font-size:14px;cursor:pointer" title="Rimuovi riga">🗑️</button></td>
    </tr>`).join("");

  document.getElementById("ordine-evaso-modal-body").innerHTML = `
    <datalist id="oev-forn-dl">${allFornitori.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
      <div>
        <label class="form-label">Fornitore</label>
        <input class="form-input" id="oev-fornitore" list="oev-forn-dl" value="${h(o.fornitore||'')}" placeholder="Fornitore">
      </div>
      <div>
        <label class="form-label">Data Ordine</label>
        <input type="date" class="form-input" id="oev-dataOrdine" value="${h(o.dataOrdine||'')}">
      </div>
      <div>
        <label class="form-label">Data Arrivo</label>
        <input type="date" class="form-input" id="oev-dataArrivo" value="${h(o.dataArrivo||'')}">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div>
        <label class="form-label">N° Fattura / Proforma</label>
        <input class="form-input" id="oev-fattura" value="${h(o.numeroFattura||o.fattura||'')}" placeholder="Es. FT-2025-001">
      </div>
      <div>
        <label class="form-label">Note</label>
        <input class="form-input" id="oev-note" value="${h(o.note||'')}" placeholder="Note…">
      </div>
    </div>
    <div style="overflow-x:auto;margin-bottom:10px">
      <table style="width:100%;border-collapse:collapse;min-width:700px">
        <thead><tr style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--txt4);background:rgba(41,37,36,.5)">
          <td style="padding:6px 8px">Produttore</td>
          <td style="padding:6px 8px">Nome Vino</td>
          <td style="padding:6px 8px">Annata</td>
          <td style="padding:6px 8px">Tipo</td>
          <td style="padding:6px 8px;text-align:center">Ord.</td>
          <td style="padding:6px 8px;text-align:center;color:var(--amber)">Arriv.</td>
          <td style="padding:6px 8px">P.Acq €</td>
          <td style="padding:6px 8px"></td>
        </tr></thead>
        <tbody id="oev-refs-body">${refsHtml}</tbody>
      </table>
    </div>
    <button onclick="_addEvasoRefRow()" class="btn-outline btn-sm" style="margin-bottom:8px">+ Aggiungi referenza</button>
    <div style="padding:10px;background:rgba(28,28,30,.6);border:1px solid var(--border);font-size:10px;color:var(--txt4)">
      ⚠️ Modificare quantità arrivate aggiorna lo storico ma <strong style="color:var(--amber3)">non ricalcola automaticamente le giacenze</strong>. Per correggere le giacenze usa un movimento manuale.
    </div>`;

  document.getElementById("ordine-evaso-modal-backdrop").classList.remove("hidden");
}

function _addEvasoRefRow(){
  const tbody = document.getElementById("oev-refs-body");
  if(!tbody) return;
  const newId = uid();
  tbody.insertAdjacentHTML("beforeend",`
    <tr data-evaso-ref-id="${newId}" style="border-top:1px solid var(--border)">
      <td style="padding:5px 8px"><input class="form-input" style="font-size:11px" value="" placeholder="Produttore"></td>
      <td style="padding:5px 8px"><input class="form-input" style="font-size:11px" value="" placeholder="Nome vino"></td>
      <td style="padding:5px 8px"><input class="form-input" style="font-size:11px;width:80px" value="" placeholder="Anno"></td>
      <td style="padding:5px 8px"><select class="form-select" style="font-size:11px" data-prev="Rosso" onchange="_addTipologiaInline(this);if(this.value!=='__new__')this.dataset.prev=this.value">${_tipoOptsHtml("")}</select></td>
      <td style="padding:5px 8px;text-align:center"><input type="number" class="form-input" style="font-size:11px;width:60px;text-align:center" value="0" min="0"></td>
      <td style="padding:5px 8px;text-align:center"><input type="number" class="form-input" style="font-size:11px;width:60px;text-align:center" value="0" min="0"></td>
      <td style="padding:5px 8px"><input type="number" class="form-input" style="font-size:11px;width:80px" value="" step="0.01" min="0" placeholder="0.00"></td>
      <td style="padding:5px 8px;text-align:center"><button onclick="this.closest('tr').remove()" style="background:none;border:none;color:#FF453A;font-size:14px;cursor:pointer">🗑️</button></td>
    </tr>`);
}

function chiudiOrdineEvasoModal(e){
  if(e && e.target !== document.getElementById("ordine-evaso-modal-backdrop")) return;
  document.getElementById("ordine-evaso-modal-backdrop").classList.add("hidden");
  _editOrdineEvasoId = null;
}

function salvaOrdineEvaso(){
  if(!_editOrdineEvasoId) return;
  const tbody = document.getElementById("oev-refs-body");
  if(!tbody){ notify("Errore: tabella non trovata","err"); return; }

  const refs = [];
  tbody.querySelectorAll("tr[data-evaso-ref-id]").forEach(row => {
    const inps = row.querySelectorAll("input");
    const sels = row.querySelectorAll("select");
    refs.push({
      id: row.dataset.evasoRefId || uid(),
      produttore: inps[0]?.value.trim() || "",
      nomeVino:   inps[1]?.value.trim() || "",
      annata:     inps[2]?.value.trim() || "",
      tipologia:  sels[0]?.value || "Rosso",
      qty:        parseInt(inps[3]?.value)||0,
      qtyArr:     parseInt(inps[4]?.value)||0,
      prezzoAcq:  parseFloat(inps[5]?.value)||0,
      iva: 22
    });
  });

  orders = orders.map(o => {
    if(o.id !== _editOrdineEvasoId) return o;
    return {
      ...o,
      fornitore:    (document.getElementById("oev-fornitore")?.value||"").trim(),
      dataOrdine:   document.getElementById("oev-dataOrdine")?.value || o.dataOrdine,
      dataArrivo:   document.getElementById("oev-dataArrivo")?.value || o.dataArrivo,
      numeroFattura:document.getElementById("oev-fattura")?.value.trim() || "",
      note:         document.getElementById("oev-note")?.value.trim() || "",
      referenze:    refs
    };
  });

  document.getElementById("ordine-evaso-modal-backdrop").classList.add("hidden");
  _editOrdineEvasoId = null;
  scheduleSave();
  notify("✅ Ordine aggiornato");
  render();
}


// ── MODAL NUOVO/MODIFICA ORDINE ──────────────────────────────────────────────
function apriOrdineModal(idOrNull){
  const allFornitori=[...new Set([...wines.map(w=>w.distributore),...orders.map(o=>o.fornitore)].filter(Boolean))].sort();
  const allProduttori=[...new Set([...wines.map(w=>w.produttore),...orders.flatMap(o=>(o.referenze||[]).map(r=>r.produttore))].filter(Boolean))].sort();
  const allNomi=[...new Set(wines.map(w=>w.nome).filter(Boolean))].sort();

  // Cerca prima in orders locali, poi nelle bozze Supabase (_bozzeSb)
  let ordine = idOrNull ? orders.find(o=>o.id===idOrNull) : null;
  if (!ordine && idOrNull) {
    const bozza = _bozzeSb.find(b=>b.id===idOrNull);
    if (bozza) {
      ordine = {
        id: bozza.id,
        _sbTestataId: bozza.id,
        _isBozzaSb: true,
        fornitore: bozza.distributore || '',
        dataOrdine: bozza.data_ordine || today(),
        note: bozza.note || '',
        stato: 'attesa',
        referenze: (bozza.righe || []).map(r => ({
          id: r.id,
          wineId: r.wine_id,
          nomeVino: r.nome_vino || '',
          produttore: r.produttore || '',
          annata: r.annata || '',
          tipologia: r.tipologia || 'Rosso',
          prezzoAcq: r.prezzo_acq || 0,
          iva: r.iva || 22,
          qty: r.qty_ordinata || 1,
          formato: r.formato || 0.75,
          regione: r.regione || '',
          zona: r.zona || '',
          nazione: r.nazione || 'Italia',
          prezzoCarta: r.prezzo_carta || '',
          note_riga: r.note_riga || ''
        }))
      };
    }
  }
  ordineModalData={
    id: ordine?.id||null,
    dataOrdine: ordine?.dataOrdine||today(),
    fornitore: ordine?.fornitore||"",
    note: ordine?.note||"",
    sconto: parseFloat(ordine?.sconto)||0,
    referenze: ordine?.referenze ? ordine.referenze.map(r=>({...r})) : []
  };
  if(ordineModalData.referenze.length===0) ordineModalData.referenze.push(_newRef());

  document.getElementById("ordine-modal-title").textContent=idOrNull?"✏️ Modifica Ordine":"➕ Nuovo Ordine";
  _renderOrdineModalBody(allFornitori, allProduttori, allNomi);
  document.getElementById("ordine-modal-backdrop").classList.remove("hidden");
}

function _newRef(produttore="",nomeVino="",annata="",tipologia="Rosso",prezzoAcq="",iva=22,qty=6,regione="",zona="",nazione="Italia",prezzoCarta="",formato="",wineId=""){
  return {id:uid(),wineId,produttore,nomeVino,annata,tipologia,prezzoAcq,iva,qty,regione,zona,nazione,prezzoCarta,formato,scontoRef:0};
}

function _renderOrdineModalBody(allFornitori, allProduttori, allNomi){
  const tipoOpts=_tipoOptsHtml("");
  const ivaOpts=IVA_OPTIONS.map(v=>`<option value="${v}">${v}%</option>`).join("");

  const allRegioni=[...new Set(wines.map(w=>w.regione).filter(Boolean))].sort();
  let refsHtml=ordineModalData.referenze.map((r,i)=>_refRowHtml(r,i,tipoOpts,ivaOpts,allProduttori,allNomi)).join("");

  document.getElementById("ordine-modal-body").innerHTML=`
    <datalist id="omd-forn-dl">${allFornitori.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
    <datalist id="omd-prod-dl">${allProduttori.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
    <datalist id="omd-wine-dl">${allNomi.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
    <datalist id="omd-reg-dl">${allRegioni.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
    <!-- Header ordine -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 2fr;gap:12px;margin-bottom:20px">
      <div>
        <label class="form-label">Data Ordine</label>
        <input id="omd-data" type="date" class="form-input" value="${h(ordineModalData.dataOrdine)}">
      </div>
      <div>
        <label class="form-label">Fornitore *</label>
        <input id="omd-fornitore" class="form-input" list="omd-forn-dl" autocomplete="off" value="${h(ordineModalData.fornitore)}" placeholder="Scrivi o scegli…" oninput="_syncFornitoreToRefs(this.value)">
      </div>
      <div>
        <label class="form-label">Sconto Fornitore %</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input id="omd-sconto" type="number" class="form-input" min="0" max="100" step="0.1" value="${ordineModalData.sconto||0}" placeholder="0" style="text-align:right" oninput="ordineModalData.sconto=parseFloat(this.value)||0;_updateOrdineModalTotale()">
          <span style="color:var(--txt3);font-size:13px;white-space:nowrap">%</span>
        </div>
      </div>
      <div>
        <label class="form-label">Note ordine</label>
        <input id="omd-note" class="form-input" value="${h(ordineModalData.note)}" placeholder="es. Ordine per settembre">
      </div>
    </div>
    <!-- Referenze -->
    <div class="modal-section-label">🍾 Referenze dell'ordine</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;min-width:1100px">
        <thead>
          <tr style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--txt4)">
            <td style="padding:6px 8px;min-width:120px">Produttore</td>
            <td style="padding:6px 8px;min-width:120px">Nome Vino</td>
            <td style="padding:6px 8px;min-width:90px">Vitigni</td>
            <td style="padding:6px 8px;min-width:56px">Annata</td>
            <td style="padding:6px 8px;min-width:90px">Tipologia</td>
            <td style="padding:6px 8px;min-width:80px">Formato</td>
            <td style="padding:6px 8px;min-width:100px">Regione</td>
            <td style="padding:6px 8px;min-width:90px">Nazione</td>
            <td style="padding:6px 8px;width:0;padding:0;overflow:hidden;max-width:0"></td>
            <td style="padding:6px 8px;min-width:90px">P.Acq ex IVA</td>
            <td style="padding:6px 8px;min-width:56px">IVA</td>
            <td style="padding:6px 8px;min-width:90px">P.Acq+IVA</td>
            <td style="padding:6px 8px;min-width:80px">P.Carta</td>
            <td style="padding:6px 8px;min-width:56px">Qty</td>
            <td style="padding:6px 8px;min-width:64px;text-align:center;background:rgba(255,69,58,.04)">Sc.%</td>
            <td style="padding:6px 8px;min-width:80px;text-align:right;background:rgba(48,209,88,.04)">Tot. riga</td>
            <td style="padding:6px 8px;min-width:28px"></td>
          </tr>
        </thead>
        <tbody id="omd-refs-body">${refsHtml}</tbody>
      </table>
    </div>
    <button class="btn-outline btn-sm" style="margin-top:10px" onclick="_addRefRow()">+ Aggiungi referenza</button>
    <div id="omd-totale" style="margin-top:12px;text-align:right;font-size:11px;color:var(--txt2)"></div>`;
  _updateOrdineModalTotale();
  // Inizializza suggerimenti P.Carta per righe con prezzoAcq già valorizzato (es. ordine in modifica)
  ordineModalData.referenze.forEach(r=>{ if(r.prezzoAcq) _updateRefCartaSuggerita(r.id); });
}

function _refRowHtml(r,i,tipoOpts,ivaOpts,allProduttori,allNomi){
  const selTipo=_tipoOptsHtml(r.tipologia);
  const selIva=IVA_OPTIONS.map(v=>`<option value="${v}"${v===r.iva?" selected":""}>${v}%</option>`).join("");
  const ivaIncl = r.prezzoAcq ? (parseFloat(r.prezzoAcq)*(1+(parseInt(r.iva)||22)/100)) : 0;
  const scontoRef = parseFloat(r.scontoRef)||0;
  const scontoOrd = parseFloat(ordineModalData?.sconto)||0;
  // Sconto cumulativo: prima sconto referenza, poi sconto ordine sul residuo
  const fattore = (1-scontoRef/100)*(1-scontoOrd/100);
  const totRiga = ivaIncl*(parseInt(r.qty)||0);
  const totRigaNetto = totRiga*fattore;
  const hasDiscount = scontoRef>0||scontoOrd>0;
  const isOmaggio = scontoRef>=100;
  const totRigaHtml = totRiga
    ? (isOmaggio
        ? `<span style="color:#30D158;font-weight:600;font-size:10px">🎁 OMAGGIO</span>`
        : hasDiscount
          ? `<span style="color:var(--txt4);text-decoration:line-through;font-size:10px">${fmtRound(totRiga)}</span><br><span style="color:#30D158">${fmtRound(totRigaNetto)}</span>`
          : `<span style="color:var(--txt2)">${fmtRound(totRiga)}</span>`)
    : "—";
  // Colore sfondo cella sconto referenza
  const scBg = scontoRef>=100 ? "rgba(48,209,88,.12)" : scontoRef>0 ? "rgba(255,69,58,.06)" : "transparent";
  return `<tr data-ref-id="${r.id}" style="border-top:1px solid var(--border)">
    <td style="padding:5px 6px"><input class="form-input" style="font-size:11px;min-width:110px;width:100%" list="omd-prod-dl" autocomplete="off" value="${h(r.produttore)}" placeholder="Produttore" onchange="_refChange('${r.id}','produttore',this.value)"></td>
    <td style="padding:5px 6px"><input class="form-input" style="font-size:11px;min-width:110px;width:100%" list="omd-wine-dl" autocomplete="off" value="${h(r.nomeVino)}" placeholder="Nome vino" onchange="_refChange('${r.id}','nomeVino',this.value);_showRefGiacenza('${r.id}',this.value)"><div id="ref-giac-${r.id}" style="font-size:9px;margin-top:2px"></div></td>
    <td style="padding:5px 6px"><input class="form-input" style="font-size:11px;min-width:80px;width:100%" value="${h(r.vitigni||'')}" placeholder="es. Nebbiolo" onchange="_refChange('${r.id}','vitigni',this.value.trim())"></td>
    <td style="padding:5px 6px"><input class="form-input" style="font-size:11px;text-align:center;min-width:52px;width:100%" value="${h(r.annata||'')}" placeholder="es. 2021" onchange="_refChange('${r.id}','annata',this.value.trim())"></td>
    <td style="padding:5px 6px"><select class="form-input" style="font-size:11px;min-width:80px;width:100%" data-prev="${h(r.tipologia)}" onchange="_addTipologiaInline(this,(v)=>_refChange('${r.id}','tipologia',v));if(this.value!=='__new__'){this.dataset.prev=this.value;_refChange('${r.id}','tipologia',this.value)}">${selTipo}</select></td>
    <td style="padding:5px 6px"><select class="form-input" style="font-size:11px;min-width:72px;width:100%" onchange="_refChange('${r.id}','formato',parseFloat(this.value)||0.75);_updateRefCartaSuggerita('${r.id}')">
      ${[{v:"0.75",l:"0.75L"},{v:"1.5",l:"1.5L Magnum"},{v:"2.0",l:"2.0L Jero."},{v:"3.0",l:"3.0L D.Mag."},{v:"4.5",l:"4.5L Réhob."},{v:"6.0",l:"6.0L Math."}].map(x=>`<option value="${x.v}" ${String(r.formato||"0.75")===x.v?"selected":""}>${x.l}</option>`).join("")}
    </select></td>
    <td style="padding:5px 6px"><input class="form-input" style="font-size:11px;min-width:90px;width:100%" list="omd-reg-dl" autocomplete="off" value="${h(r.regione||'')}" placeholder="es. Piemonte" onchange="_refChange('${r.id}','regione',this.value.trim())"></td>
    <td style="padding:5px 6px"><input class="form-input" style="font-size:11px;min-width:80px;width:100%" value="${h(r.nazione||'Italia')}" placeholder="es. Italia" onchange="_refChange('${r.id}','nazione',this.value.trim())"></td>
    <td style="padding:0;width:0;overflow:hidden;max-width:0"><input class="form-input" style="font-size:11px;width:0;border:none;padding:0;background:none" value="${h(r.zona||'')}" onchange="_refChange('${r.id}','zona',this.value.trim())"></td>
    <td style="padding:5px 6px"><input type="number" class="form-input" style="font-size:11px;min-width:80px;width:100%" value="${r.prezzoAcq||''}" step="0.01" min="0" placeholder="0.00" onchange="_refChange('${r.id}','prezzoAcq',parseFloat(this.value)||0);_updateRefIvaIncl('${r.id}');_updateRefCartaSuggerita('${r.id}')" oninput="_refChange('${r.id}','prezzoAcq',parseFloat(this.value)||0);_updateRefIvaIncl('${r.id}');_updateRefCartaSuggerita('${r.id}');_updateOrdineModalTotale()"></td>
    <td style="padding:5px 6px"><select class="form-input" style="font-size:11px;min-width:52px;width:100%" onchange="_refChange('${r.id}','iva',parseInt(this.value));_updateRefIvaIncl('${r.id}');_updateRefCartaSuggerita('${r.id}');_updateOrdineModalTotale()">${selIva}</select></td>
    <td style="padding:5px 6px;text-align:right;font-size:12px;color:var(--amber);font-weight:600;white-space:nowrap;background:rgba(255,159,10,.06);border-left:1px solid rgba(255,159,10,.12)" id="ref-ivaincl-${r.id}">${ivaIncl?fmtRound(ivaIncl):"—"}</td>
    <td style="padding:5px 6px"><input type="number" id="ref-carta-inp-${r.id}" class="form-input" style="font-size:11px;text-align:right;min-width:72px;width:100%" value="${r.prezzoCarta||''}" step="1" min="0" placeholder="0" onchange="_refChange('${r.id}','prezzoCarta',parseFloat(this.value)||0)"><div id="ref-carta-hint-${r.id}" style="font-size:9px;margin-top:2px;white-space:nowrap"></div></td>
    <td style="padding:5px 6px"><input type="number" class="form-input" style="font-size:12px;text-align:center;min-width:52px;width:100%" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" value="${r.qty||6}" min="1" step="1" oninput="_refChange('${r.id}','qty',parseInt(this.value)||1);_updateOrdineModalTotale()"></td>
    <td style="padding:3px 4px;background:${scBg};border-left:1px solid rgba(255,69,58,.15)">
      <input type="number" class="form-input" id="ref-sc-${r.id}" style="font-size:11px;text-align:center;min-width:52px;width:100%;background:transparent;border-color:rgba(255,69,58,.2)" min="0" max="100" step="1" value="${scontoRef||''}" placeholder="0"
        oninput="_refChange('${r.id}','scontoRef',parseFloat(this.value)||0)"
        title="Sconto referenza % (100 = omaggio)">
      ${scontoRef>=100?`<div style="font-size:8px;color:#30D158;text-align:center;margin-top:1px">🎁</div>`:scontoRef>0?`<div style="font-size:8px;color:#FF453A;text-align:center;margin-top:1px">−${scontoRef}%</div>`:''}
    </td>
    <td id="ref-tot-${r.id}" style="padding:5px 8px;text-align:right;font-size:11px;white-space:nowrap;background:rgba(48,209,88,.04);border-left:1px solid rgba(48,209,88,.12)">${totRigaHtml}</td>
    <td style="padding:5px 6px;text-align:right"><button onclick="_removeRefRow('${r.id}')" style="color:var(--txt4);font-size:13px;background:none;border:none;cursor:pointer" title="Rimuovi">✕</button></td>
  </tr>`;
}


function _syncFornitoreToRefs(val){
  ordineModalData.fornitore=val;
}

function _refChange(refId,field,value){
  const r=ordineModalData.referenze.find(x=>x.id===refId);
  if(r){
    r[field]=field==='vitigni'?value.split(",").map(v=>v.trim()).filter(Boolean).join(", "):value;
    // FIX FORMATO: se cambia il formato, il wineId assegnato (per nome) non è più valido
    if(field==='formato'){ r.wineId=""; _showRefGiacenza(refId, r.nomeVino); }
  }
  _updateOrdineModalTotale();
}

// _refAutofill rimosso — l'autofill creava comportamenti inattesi (match parziali
// sovrascrivevano campi compilati manualmente). I datalist HTML forniscono già
// suggerimenti senza side effect. Solo _refChange aggiorna lo stato.

function _addRefRow(){
  ordineModalData.referenze.push(_newRef());
  const allProd=[...new Set([...wines.map(w=>w.produttore),...orders.flatMap(o=>(o.referenze||[]).map(r=>r.produttore))].filter(Boolean))].sort();
  const allNomi=[...new Set(wines.map(w=>w.nome).filter(Boolean))].sort();
  const tbody=document.getElementById("omd-refs-body");
  if(tbody){
    const r=ordineModalData.referenze[ordineModalData.referenze.length-1];
    const i=ordineModalData.referenze.length-1;
    const tipoOpts=_tipoOptsHtml("");
    const ivaOpts=IVA_OPTIONS.map(v=>`<option value="${v}">${v}%</option>`).join("");
    const tr=document.createElement("tr");
    tr.outerHTML; // not used, just insert HTML
    tbody.insertAdjacentHTML("beforeend",_refRowHtml(r,i,tipoOpts,ivaOpts,allProd,allNomi));
    // update datalists
    const dl=document.getElementById("omd-prod-dl");
    if(dl) dl.innerHTML=allProd.map(v=>`<option value="${h(v)}">`).join("");
    const dlw=document.getElementById("omd-wine-dl");
    if(dlw) dlw.innerHTML=allNomi.map(v=>`<option value="${h(v)}">`).join("");
    const dlr=document.getElementById("omd-reg-dl");
    const allReg=[...new Set(wines.map(w=>w.regione).filter(Boolean))].sort();
    if(dlr) dlr.innerHTML=allReg.map(v=>`<option value="${h(v)}">`).join("");
  }
  _updateOrdineModalTotale();
}

function _updateRefIvaIncl(refId){
  const r=ordineModalData?.referenze.find(x=>x.id===refId);
  const el=document.getElementById(`ref-ivaincl-${refId}`);
  if(!r||!el) return;
  const v=(parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100);
  el.textContent=v?fmtRound(v):"—";
}

function _updateRefCartaSuggerita(refId){
  const r=ordineModalData?.referenze.find(x=>x.id===refId);
  const hint=document.getElementById(`ref-carta-hint-${refId}`);
  const inp=document.getElementById(`ref-carta-inp-${refId}`);
  if(!r||!hint) return;
  const p=parseFloat(r.prezzoAcq)||0;
  if(!p){ hint.textContent=""; return; }
  // Costruisce oggetto temporaneo compatibile con _calcPrezzoCartaSuggerito
  const pseudo={prezzoAcq:p, iva:parseInt(r.iva)||22, formato:parseFloat(r.formato)||0.75};
  const sug=_calcPrezzoCartaSuggerito(pseudo);
  const label=_getMoltLabel(pseudo);
  if(!sug){ hint.textContent=""; return; }
  hint.innerHTML=`<span style="color:var(--txt4)">${label} → </span><button type="button" onclick="_applyCartaSuggerita('${refId}',${sug})" style="background:none;border:none;color:#30D158;font-size:9px;cursor:pointer;padding:0;font-family:inherit;text-decoration:underline;text-underline-offset:2px">applica €${sug}</button>`;
  // Se il campo P.Carta è ancora vuoto, pre-compila silenziosamente
  if(inp && !inp.value){
    inp.value=sug;
    _refChange(refId,'prezzoCarta',sug);
  }
}
function _applyCartaSuggerita(refId, val){
  const inp=document.getElementById(`ref-carta-inp-${refId}`);
  if(inp){ inp.value=val; inp.focus(); }
  _refChange(refId,'prezzoCarta',val);
  const hint=document.getElementById(`ref-carta-hint-${refId}`);
  if(hint) hint.innerHTML=`<span style="color:#30D158;font-size:9px">✓ applicato</span>`;
}

function _showRefGiacenza(refId, nomeVino){
  const el = document.getElementById("ref-giac-"+refId);
  if(!el) return;
  const ref = ordineModalData?.referenze?.find(r=>r.id===refId);
  // FIX FORMATO: cerca il vino con lo stesso nome E lo stesso formato della referenza
  const _fmt = String(parseFloat(ref?.formato)||0.75);
  const w = wines.find(x => x.nome.toLowerCase() === (nomeVino||"").toLowerCase().trim()
    && String(parseFloat(x.formato)||0.75) === _fmt);
  if(!w){ el.textContent=""; return; }
  // T-B6: salva wineId nella referenza — T-B5 userà match stabile per id alla ricezione
  if(ref && !ref.wineId) ref.wineId = w.id;
  const g = parseInt(w.giacenza)||0;
  const color = g===0?"#FF453A":g<=3?"#fb923c":"#30D158";
  el.innerHTML = `<span style="color:${color}">⬢ ${g} bt in cantina</span>`;
}
function _removeRefRow(refId){
  if(ordineModalData.referenze.length<=1){notify("L'ordine deve avere almeno una referenza","err");return;}
  ordineModalData.referenze=ordineModalData.referenze.filter(r=>r.id!==refId);
  const row=document.querySelector(`tr[data-ref-id="${refId}"]`);
  if(row) row.remove();
  _updateOrdineModalTotale();
}

function _updateOrdineModalTotale(){
  const el=document.getElementById("omd-totale");
  if(!el) return;
  if(!ordineModalData?.referenze){el.textContent="";return;}
  const scontoOrd=parseFloat(ordineModalData.sconto)||0;
  let totQty=0,totLordo=0,totNetto=0;
  ordineModalData.referenze.forEach(r=>{
    const q=parseInt(r.qty)||0;
    const p=parseFloat(r.prezzoAcq)||0;
    const iva=(parseInt(r.iva)||22);
    const scontoRef=parseFloat(r.scontoRef)||0;
    const fattore=(1-scontoRef/100)*(1-scontoOrd/100);
    const rigaLorda=p*(1+iva/100)*q;
    const rigaNetta=rigaLorda*fattore;
    totQty+=q;
    totLordo+=rigaLorda;
    totNetto+=rigaNetta;
    // Aggiorna cella tot riga
    const rigaEl=document.getElementById(`ref-tot-${r.id}`);
    if(rigaEl){
      const isOmaggio=scontoRef>=100;
      const hasDiscount=scontoRef>0||scontoOrd>0;
      rigaEl.innerHTML = rigaLorda
        ? (isOmaggio
            ? `<span style="color:#30D158;font-weight:600;font-size:10px">🎁 OMAGGIO</span>`
            : hasDiscount
              ? `<span style="color:var(--txt4);text-decoration:line-through;font-size:10px">${fmtRound(rigaLorda)}</span><br><span style="color:#30D158">${fmtRound(rigaNetta)}</span>`
              : `<span style="color:var(--txt2)">${fmtRound(rigaLorda)}</span>`)
        : "—";
    }
    // Aggiorna mini-badge sotto input sconto referenza
    const scEl=document.getElementById(`ref-sc-${r.id}`);
    if(scEl){
      const badge=scEl.nextElementSibling;
      if(badge){
        badge.innerHTML=scontoRef>=100
          ?`<div style="font-size:8px;color:#30D158;text-align:center;margin-top:1px">🎁</div>`
          :scontoRef>0
            ?`<div style="font-size:8px;color:#FF453A;text-align:center;margin-top:1px">−${scontoRef}%</div>`
            :'';
      }
    }
  });
  const importoSconto=totLordo-totNetto;
  const hasAnyDiscount=totLordo>totNetto;
  const scontoHtml=hasAnyDiscount
    ? ` <span style="color:#FF453A;margin:0 6px">− ${fmt(importoSconto)}</span><span style="color:var(--txt4)">→</span> <strong style="color:#30D158;font-size:13px;margin-left:6px">${fmt(totNetto)}</strong> netto`
    : '';
  el.innerHTML=`Lordo IVA incl.: <span style="color:var(--amber)">${fmt(totLordo)}</span>${scontoHtml} · <span style="color:var(--txt2)">${totQty} bottiglie</span>`;
}

function salvaOrdine(){
  // Read header from DOM
  const fornitore=(document.getElementById("omd-fornitore")?.value||"").trim();
  const dataOrdine=document.getElementById("omd-data")?.value||today();
  const note=(document.getElementById("omd-note")?.value||"").trim();
  if(!fornitore){notify("⚠️ Inserisci il fornitore","err");return;}
  // Read refs from in-memory ordineModalData.referenze (kept in sync by _refChange)
  // instead of fragile positional DOM selectors.
  const refs=[];
  let ok=true;
  (ordineModalData?.referenze||[]).forEach(r=>{
    const nomeVino=(r.nomeVino||"").trim();
    if(!nomeVino){ok=false;return;}
    // FIX FORMATO: il wineId assegnato per nome deve rispettare anche il formato
    const _fmt=String(parseFloat(r.formato)||0.75);
    const wineId=r.wineId||(wines.find(w=>w.nome.toLowerCase()===nomeVino.toLowerCase()&&String(parseFloat(w.formato)||0.75)===_fmt)?.id||"");
    refs.push({
      id:r.id||uid(), wineId,
      produttore:(r.produttore||"").trim(),
      nomeVino,
      vitigni:_normVitigni(r.vitigni),
      annata:(r.annata||"").trim(),
      tipologia:r.tipologia||"Rosso",
      formato:parseFloat(r.formato)||0.75,
      regione:(r.regione||"").trim(),
      zona:(r.zona||"").trim(),
      nazione:(r.nazione||"Italia").trim(),
      prezzoAcq:parseFloat(r.prezzoAcq)||0,
      iva:parseInt(r.iva)||22,
      prezzoCarta:parseFloat(r.prezzoCarta)||0,
      qty:parseInt(r.qty)||1,
      scontoRef:parseFloat(r.scontoRef)||0
    });
  });
  if(!ok){notify("⚠️ Inserisci il nome vino per tutte le referenze","err");return;}
  if(!refs.length){notify("⚠️ Aggiungi almeno una referenza","err");return;}

  const _bozzaId = _bozzeSb.some(b=>b.id===ordineModalData.id) ? ordineModalData.id : null;
  if(ordineModalData.id){
    // Update existing
    const idx=orders.findIndex(o=>o.id===ordineModalData.id);
    if(idx>=0){
      orders[idx]={...orders[idx],fornitore,dataOrdine,note,sconto:parseFloat(document.getElementById("omd-sconto")?.value)||ordineModalData.sconto||0,referenze:refs};
    } else {
      // Bozza remota (_bozzeSb): promuovi a ordine normale in orders.
      // _sbTestataId mantiene il dedup in renderOrdini (riga ~2884) finché la
      // bozza Supabase non è cancellata; _bozzeSb viene ripulito subito.
      orders.push({id:ordineModalData.id,_sbTestataId:ordineModalData.id,fornitore,dataOrdine,note,sconto:parseFloat(document.getElementById("omd-sconto")?.value)||ordineModalData.sconto||0,referenze:refs,stato:"attesa"});
      _bozzeSb=_bozzeSb.filter(b=>b.id!==ordineModalData.id);
    }
  } else {
    orders.push({id:uid(),fornitore,dataOrdine,note,sconto:parseFloat(document.getElementById("omd-sconto")?.value)||ordineModalData.sconto||0,referenze:refs,stato:"attesa"});
  }
  scheduleSave();
  // PATCH: flush immediato per ordini — non aspettare il debounce da 400ms.
  // Il mutex _saveInFlight in _flushSave gestisce la concorrenza correttamente.
  clearTimeout(saveTimer);
  _flushSave();
  // Cancella la bozza Supabase (ordini_testata + righe via cascade) così non
  // riappare al prossimo _loadBozzeSb(). Fire-and-forget: l'ordine è già in cm_orders.
  if(_bozzaId && _sb){
    _sb.from('ordini_testata').delete().eq('id',_bozzaId)
      .then(()=>{}, e=>console.warn('delete bozza fallita:',e));
  }
  chiudiOrdineModal();
  notify("🛒 Ordine salvato");
  render();
}

function chiudiOrdineModal(e){
  if(e&&e.target!==document.getElementById("ordine-modal-backdrop")) return;
  document.getElementById("ordine-modal-backdrop").classList.add("hidden");
  ordineModalData=null;
}

// ── MODAL RICEZIONE SINGOLO ORDINE ───────────────────────────────────────────
function apriModalRicezione(ordineId){
  const ordine=orders.find(o=>o.id===ordineId);
  if(!ordine){notify("Ordine non trovato","err");return;}
  const allFornitori=[...new Set([...wines.map(w=>w.distributore),...orders.map(o=>o.fornitore)].filter(Boolean))].sort();
  const allProduttori=[...new Set([...wines.map(w=>w.produttore),...orders.flatMap(o=>(o.referenze||[]).map(r=>r.produttore))].filter(Boolean))].sort();
  const allNomi=[...new Set(wines.map(w=>w.nome).filter(Boolean))].sort();

  // Pre-populate with existing arrival data if already confirmed
  ricezioneModalData={
    ordineId,
    dataArrivo: ordine.dataArrivo || today(),
    fattura: ordine.numeroFattura || ordine.fattura || "",
    righe: (ordine.referenze||[]).map(r=>({...r, qtyArr: r.qtyArr ?? r.qty}))
  };
  _renderRicezioneModalBody(ordine, allFornitori, allProduttori, allNomi);
  document.getElementById("ricezione-modal-backdrop").classList.remove("hidden");
}

function _renderRicezioneModalBody(ordine, allForn, allProd, allNomi){
  const tipoOpts=_tipoOptsHtml("");
  const ivaOpts=IVA_OPTIONS.map(v=>`<option value="${v}">${v}%</option>`).join("");

  const righeHtml=ricezioneModalData.righe.map(r=>`
    <tr data-ric-id="${r.id}" style="border-top:1px solid var(--border)">
      <td style="padding:5px 8px;color:var(--txt3)">${h(r.produttore||'—')}</td>
      <td style="padding:5px 8px">${h(r.nomeVino)}</td>
      <td style="padding:5px 8px;color:var(--amber);font-family:'Montserrat',sans-serif;text-align:center;font-size:11px;white-space:nowrap">${r.annata?h(r.annata):'<span style="color:var(--txt4)">N.V.</span>'}</td>
      <td style="padding:5px 8px;color:var(--txt4);font-size:10px;text-align:center;white-space:nowrap">${parseFloat(r.formato)||0.75}L</td>
      <td style="padding:5px 8px;color:var(--txt3);font-size:10px">${h(r.vitigni||'—')}</td>
      <td style="padding:5px 8px">${badge(r.tipologia)}</td>
      <td style="padding:5px 8px;color:var(--txt2);text-align:center">${r.qty}</td>
      <td style="padding:5px 8px">
        <input type="number" class="form-input" style="font-size:11px;text-align:center" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" value="${r.qtyArr}" min="0" step="1"
          onchange="ricezioneModalData.righe.find(x=>x.id==='${r.id}').qtyArr=parseInt(this.value)||0;_aggiornaRicTotale()" 
          oninput="ricezioneModalData.righe.find(x=>x.id==='${r.id}').qtyArr=parseInt(this.value)||0;_aggiornaRicTotale()">
      </td>
      <td style="padding:5px 8px">
        <input type="number" class="form-input" style="font-size:11px" value="${r.prezzoAcq||''}" step="0.01" min="0" placeholder="0.00"
          onchange="ricezioneModalData.righe.find(x=>x.id==='${r.id}').prezzoAcq=parseFloat(this.value)||0;_aggiornaRicTotale()">
      </td>
    </tr>`).join("");

  document.getElementById("ricezione-modal-body").innerHTML=`
    <datalist id="ric-prod-dl">${allProd.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
    <datalist id="ric-wine-dl">${allNomi.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
    <div style="background:rgba(255,159,10,.08);border:1px solid rgba(180,83,9,.3);padding:10px 14px;margin-bottom:16px;font-size:11px">
      <span style="color:var(--amber3);font-weight:600">Fornitore:</span> <span style="color:var(--txt2)">${h(ordine.fornitore)}</span>
      &nbsp;·&nbsp;<span style="color:var(--amber3);font-weight:600">Ordine del:</span> <span style="color:var(--txt2)">${h(ordine.dataOrdine)}</span>
      ${ordine.note?`&nbsp;·&nbsp;<span style="color:var(--txt4)">${h(ordine.note)}</span>`:""}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div><label class="form-label">Data Arrivo Effettiva</label>
        <input id="ric-data-input" type="date" class="form-input" value="${today()}" onchange="ricezioneModalData.dataArrivo=this.value"></div>
      <div><label class="form-label">Numero Fattura <span style="color:var(--txt4)">(opzionale)</span></label>
        <input id="ric-fattura-input" type="text" class="form-input" placeholder="Es. FT-2025-001" onchange="ricezioneModalData.fattura=this.value.trim()"></div>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;min-width:600px">
        <thead><tr style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--txt4)">
          <td style="padding:6px 8px">Produttore</td>
          <td style="padding:6px 8px">Nome Vino</td>
          <td style="padding:6px 8px;text-align:center;color:var(--amber)">Annata</td>
          <td style="padding:6px 8px;text-align:center">Formato</td>
          <td style="padding:6px 8px">Vitigni</td>
          <td style="padding:6px 8px">Tipo</td>
          <td style="padding:6px 8px;text-align:center">Ordinato</td>
          <td style="padding:6px 8px;text-align:center;color:var(--amber)">Arrivato ✏️</td>
          <td style="padding:6px 8px">P.Acq ✏️</td>
        </tr></thead>
        <tbody id="ric-righe-body">${righeHtml}</tbody>
      </table>
    </div>
    <button class="btn-outline btn-sm" style="margin-top:10px" onclick="_addRicezioneRow()">+ Referenza non prevista</button>
    <div id="ric-totale" style="margin-top:12px;text-align:right;font-size:11px;color:var(--txt2)"></div>`;
  _aggiornaRicTotale();
}

function _aggiornaRicTotale(){
  const el=document.getElementById("ric-totale");
  if(!el||!ricezioneModalData) return;
  const totQty=ricezioneModalData.righe.reduce((s,r)=>s+(parseInt(r.qtyArr)||0),0);
  const totVal=ricezioneModalData.righe.reduce((s,r)=>s+(parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100)*(parseInt(r.qtyArr)||0),0);
  el.innerHTML=`Totale arrivo: <span style="color:var(--amber)">${fmt(totVal)}</span> IVA incl. · <span style="color:var(--txt2)">${totQty} bottiglie</span>`;
}

function _addRicezioneRow(){
  const newR={id:uid(),produttore:"",nomeVino:"",tipologia:"Rosso",prezzoAcq:0,iva:22,qty:0,qtyArr:0,_extra:true};
  ricezioneModalData.righe.push(newR);
  const tbody=document.getElementById("ric-righe-body");
  if(!tbody) return;
  const allProd=[...new Set([...wines.map(w=>w.produttore)].filter(Boolean))].sort();
  const allNomi=[...new Set(wines.map(w=>w.nome).filter(Boolean))].sort();
  const tipoOpts=_tipoOptsHtml("");
  const ivaOpts=IVA_OPTIONS.map(v=>`<option value="${v}">${v}%</option>`).join("");
  tbody.insertAdjacentHTML("beforeend",`
    <tr data-ric-id="${newR.id}" style="border-top:1px solid var(--border);background:rgba(255,159,10,.05)">
      <td style="padding:5px 6px"><input class="form-input" style="font-size:11px" list="ric-prod-dl" autocomplete="off" placeholder="Produttore"
        oninput="_ricRefChange('${newR.id}','produttore',this.value)"></td>
      <td style="padding:5px 6px"><input class="form-input" style="font-size:11px" list="ric-wine-dl" autocomplete="off" placeholder="Nome vino"
        oninput="_ricRefChange('${newR.id}','nomeVino',this.value)"></td>
      <td style="padding:5px 6px"><select class="form-input" style="font-size:11px" data-prev="Rosso" onchange="_addTipologiaInline(this,(v)=>_ricRefChange('${newR.id}','tipologia',v));if(this.value!=='__new__'){this.dataset.prev=this.value;_ricRefChange('${newR.id}','tipologia',this.value)}">${tipoOpts}</select></td>
      <td style="padding:5px 8px;text-align:center;color:var(--txt4);font-size:11px">—</td>
      <td style="padding:5px 6px"><input type="number" class="form-input" style="font-size:11px;text-align:center" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" value="0" min="0"
        oninput="_ricRefChange('${newR.id}','qtyArr',parseInt(this.value)||0);_aggiornaRicTotale()"></td>
      <td style="padding:5px 6px"><input type="number" class="form-input" style="font-size:11px" value="" step="0.01" min="0" placeholder="0.00"
        oninput="_ricRefChange('${newR.id}','prezzoAcq',parseFloat(this.value)||0);_aggiornaRicTotale()"></td>
    </tr>`);
  _aggiornaRicTotale();
}

function _ricRefChange(refId,field,value){
  const r=ricezioneModalData.righe.find(x=>x.id===refId);
  if(r) r[field]=value;
}

// _ricRefAutofill rimosso insieme a _refAutofill.

function confermaRicezioneOrdine(){
  if(!ricezioneModalData){notify("Errore: dati ricezione mancanti","err");return;}
  const dataArrivo=document.getElementById("ric-data-input")?.value||today();
  const fattura=(document.getElementById("ric-fattura-input")?.value||"").trim();
  ricezioneModalData.dataArrivo=dataArrivo;
  ricezioneModalData.fattura=fattura;

  const daProcessare=ricezioneModalData.righe.filter(r=>(parseInt(r.qtyArr)||0)>0);
  if(!daProcessare.length){notify("⚠️ Nessuna bottiglia da caricare","err");return;}

  // Validate: qtyArr cannot exceed qty ordered (skip _extra rows)
  for(const r of daProcessare){
    if(!r._extra && (parseInt(r.qtyArr)||0) > (parseInt(r.qty)||0)){
      notify(`⚠️ ${r.nomeVino}: quantità arrivata (${r.qtyArr}) supera quella ordinata (${r.qty})`, "err");
      return;
    }
  }

  daProcessare.forEach(r=>{
    // T-B4: prefer stable wineId stored at order creation; fall back to name-match for legacy orders
    // T-B5: fallback a 3 livelli — evita match sbagliato su stesso nome ma annata/produttore diversi
    // FIX FORMATO: il match deve considerare anche il formato bottiglia — una magnum (1.5)
    // NON deve matchare la voce 0.75 dello stesso vino. Default formato: 0.75.
    const rFmt=String(parseFloat(r.formato)||0.75);
    const sameFmt=w=>String(parseFloat(w.formato)||0.75)===rFmt;
    const sameAnnata=w=>(w.annata||"").toLowerCase().trim()===(r.annata||"").toLowerCase().trim();

    console.log(`[Ricezione] matching "${r.nomeVino}" annata="${r.annata||'NV'}" prod="${r.produttore||''}" fmt=${rFmt} wineId="${r.wineId||'—'}"`);

    // Prima cerca per wineId — ma valida ANCHE annata e formato per evitare di caricare
    // su un vino omonimo di annata diversa (es. ordine Syrah 2023 con wineId che punta a Syrah 2021)
    let existingIdx = r.wineId ? wines.findIndex(w=>w.id===r.wineId&&sameFmt(w)&&sameAnnata(w)) : -1;

    // Se wineId c'è ma annata/formato non combaciano, tenta comunque il match per id ignorando annata
    // SOLO se la referenza non ha annata (NV): in quel caso il wineId è affidabile
    if(existingIdx<0 && r.wineId && !(r.annata||"").trim()){
      existingIdx=wines.findIndex(w=>w.id===r.wineId&&sameFmt(w));
    }

    if(existingIdx < 0){
      const nn=r.nomeVino.toLowerCase(), rp=(r.produttore||"").toLowerCase(), ra=(r.annata||"").toLowerCase().trim();
      // Match nome+produttore+annata (caso principale con annata)
      if(rp&&ra) existingIdx=wines.findIndex(w=>w.nome.toLowerCase()===nn&&(w.produttore||"").toLowerCase()===rp&&(w.annata||"").toLowerCase().trim()===ra&&sameFmt(w));
      // fallback nome+produttore SOLO se la referenza è NV e il vino in inventario è NV
      if(existingIdx<0&&rp&&!ra) existingIdx=wines.findIndex(w=>w.nome.toLowerCase()===nn&&(w.produttore||"").toLowerCase()===rp&&!(w.annata||"").trim()&&sameFmt(w));
      // ultimo fallback nome solo se né produttore né annata specificati
      if(existingIdx<0&&!rp&&!ra) existingIdx=wines.findIndex(w=>w.nome.toLowerCase()===nn&&sameFmt(w));
    }
    let wine = existingIdx >= 0 ? wines[existingIdx] : null;

    const ordine=orders.find(o=>o.id===ricezioneModalData.ordineId);
    const fornitureName = ordine?.fornitore||"";

    if(!wine){
      // Nessun match trovato — crea nuovo vino in inventario
      // Log visibile: avvisa l'utente che è stato creato un nuovo vino (non aggiornato uno esistente)
      console.warn(`[Ricezione] Nessun match per "${r.nomeVino}" ${r.annata||'NV'} (wineId=${r.wineId||'—'}, fmt=${rFmt}) — creato come nuovo vino`);
      notify(`➕ Nuovo vino creato: ${r.nomeVino}${r.annata?' '+r.annata:''}`, "info");
      const newWine = {id:uid(),nome:r.nomeVino,produttore:r.produttore||"",distributore:fornitureName,
        annata:r.annata||"",vitigni:r.vitigni||"",tipologia:r.tipologia||"Bianco",regione:r.regione||"",nazione:r.nazione||"Italia",zona:r.zona||"",
        formato:parseFloat(r.formato)||0.75,
        prezzoAcq:r.prezzoAcq||0,iva:r.iva||22,prezzoCarta:r.prezzoCarta||0,giacenza:0,lots:[]};
      wines = [...wines, newWine];
      wine = wines[wines.length - 1];
    }

    const pAcq=parseFloat(r.prezzoAcq)||parseFloat(wine.prezzoAcq)||0;
    const qtyArr=parseInt(r.qtyArr)||0;
    const newLot={id:uid(),data:dataArrivo,fattura,fornitore:fornitureName||wine.distributore||"",
      prezzoAcq:pAcq,iva:r.iva||wine.iva||22,qtyCaricata:qtyArr,qtyRimanente:qtyArr};

    // Traccia variazione prezzi sull'oggetto corrente (non muta)
    const trackedRic=_trackPriceChange(wine, pAcq, null, 'ricezione_ordine');

    // Aggiornamento immutabile del vino nell'array globale
    // FIX FORNITORE: aggiorna distributore se il vino non ce l'ha già
    const updatedWine = {
      ...trackedRic,
      distributore: wine.distributore || fornitureName,
      giacenza: (parseInt(wine.giacenza)||0) + qtyArr,
      prezzoAcq: pAcq,
      lots: [...(wine.lots||[]), newLot],
    };
    wines = wines.map(w => w.id === updatedWine.id ? updatedWine : w);
    // Aggiorna riferimento locale per le operazioni successive (ordine, referenze)
    wine = updatedWine;

    movements.unshift({id:uid(),wineId:wine.id,wineName:wine.nome,produttore:wine.produttore,nazione:wine.nazione||"",
      tipo:"carico",qty:qtyArr,data:dataArrivo,fattura,prezzoAcqLotto:pAcq,
      fornitore:fornitureName,note:"Da ordine "+ordine?.dataOrdine,ts:Date.now()});

    // Aggiorna qtyArr sulla referenza nell'ordine (oggetto ordine, mutazione locale accettabile)
    const refInOrd=(ordine?.referenze||[]).find(x=>x.id===r.id);
    if(refInOrd) refInOrd.qtyArr=qtyArr;
    if(r._extra&&ordine) ordine.referenze.push({...r});
  });
  const ordine=orders.find(o=>o.id===ricezioneModalData.ordineId);
  if(ordine){
    ordine.stato="caricato";
    ordine.dataArrivo=dataArrivo;
    ordine.dataCarico=today();
    if(fattura) ordine.numeroFattura=fattura;
  }
  scheduleSave();
  // PATCH: flush immediato — ricezione ordine è irreversibile
  clearTimeout(saveTimer);
  _flushSave();
  chiudiRicezioneModal();
  notify(`✅ ${daProcessare.length} referenze caricate in magazzino!`);
  render();
}

function chiudiRicezioneModal(e){
  if(e&&e.target!==document.getElementById("ricezione-modal-backdrop")) return;
  document.getElementById("ricezione-modal-backdrop").classList.add("hidden");
  ricezioneModalData=null;
}

// ── MODAL RICEZIONE MULTIPLA (globale) ───────────────────────────────────────
function apriModalRicezioneGlobale(){
  const selezionati=orders.filter(o=>{
    const cb=document.querySelector(`.ord-check[data-id="${o.id}"]`);
    return cb&&cb.checked&&o.stato!=="caricato";
  });
  if(!selezionati.length){notify("⚠️ Seleziona almeno un ordine dalla lista","err");return;}
  const prev=document.getElementById("ric-glob-preview");
  if(prev){
    prev.innerHTML=selezionati.map(o=>{
      const ref=o.referenze||[];
      const totQty=ref.reduce((s,r)=>s+(parseInt(r.qty)||0),0);
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;color:var(--txt2);margin-bottom:4px">${h(o.fornitore)} <span style="color:var(--txt4);font-weight:400;font-size:10px">(${h(o.dataOrdine)})</span></div>
        ${ref.map(r=>`<div style="padding:2px 8px;font-size:10px;display:flex;justify-content:space-between"><span>${h(r.nomeVino)}${r.annata?` <span style="color:var(--amber)">${h(r.annata)}</span>`:''}</span><span style="color:var(--txt3)">× ${r.qty} bt.</span></div>`).join("")}
        <div style="font-size:10px;color:var(--amber);text-align:right;margin-top:2px">${totQty} bottiglie totali</div>
      </div>`;}).join("");
  }
  document.getElementById("ric-glob-data").value=today();
  document.getElementById("ricezione-globale-backdrop").classList.remove("hidden");
}

function chiudiRicezioneGlobale(e){
  if(e&&e.target!==document.getElementById("ricezione-globale-backdrop")) return;
  document.getElementById("ricezione-globale-backdrop").classList.add("hidden");
}

function confermaRicezioneGlobale(){
  const dataArrivo=document.getElementById("ric-glob-data").value||today();
  const fattura=(document.getElementById("ric-glob-fattura").value||"").trim();
  const selezionati=orders.filter(o=>{
    const cb=document.querySelector(`.ord-check[data-id="${o.id}"]`);
    return cb&&cb.checked&&o.stato!=="caricato";
  });
  if(!selezionati.length){notify("Nessun ordine selezionato","err");return;}
  let totRef=0;
  const newMovsGlob=[];
  selezionati.forEach(ordine=>{
    (ordine.referenze||[]).forEach(r=>{
      const qty=parseInt(r.qty)||0;
      if(!qty) return;

      // T-B4: prefer stable wineId stored at order creation; fall back to name-match for legacy orders
      // T-B5: fallback a 3 livelli — evita match sbagliato su stesso nome ma annata/produttore diversi
      // FIX FORMATO: il match deve considerare anche il formato bottiglia
      const rFmt=String(parseFloat(r.formato)||0.75);
      const sameFmt=w=>String(parseFloat(w.formato)||0.75)===rFmt;
      let existingIdx = r.wineId ? wines.findIndex(w=>w.id===r.wineId&&sameFmt(w)) : -1;
      if(existingIdx < 0){
        const nn=r.nomeVino.toLowerCase(), rp=(r.produttore||"").toLowerCase(), ra=(r.annata||"").toLowerCase();
        // FIX ANNATA: se l'ordine ha un'annata, il match senza annata è vietato
        if(rp&&ra) existingIdx=wines.findIndex(w=>w.nome.toLowerCase()===nn&&(w.produttore||"").toLowerCase()===rp&&(w.annata||"").toLowerCase()===ra&&sameFmt(w));
        // fallback nome+produttore SOLO se l'ordine non ha annata (NV)
        if(existingIdx<0&&rp&&!ra) existingIdx=wines.findIndex(w=>w.nome.toLowerCase()===nn&&(w.produttore||"").toLowerCase()===rp&&!(w.annata||"").trim()&&sameFmt(w));
        // ultimo fallback nome solo se né produttore né annata specificati
        if(existingIdx<0&&!rp&&!ra) existingIdx=wines.findIndex(w=>w.nome.toLowerCase()===nn&&sameFmt(w));
      }
      let wine = existingIdx>=0 ? wines[existingIdx] : null;

      const fornitureName = ordine.fornitore||"";

      if(!wine){
        const newWine={id:uid(),nome:r.nomeVino,produttore:r.produttore||"",distributore:fornitureName,
          annata:r.annata||"",vitigni:r.vitigni||"",tipologia:r.tipologia||"Bianco",regione:r.regione||"",nazione:r.nazione||"Italia",zona:r.zona||"",
          formato:parseFloat(r.formato)||0.75,
          prezzoAcq:r.prezzoAcq||0,iva:r.iva||22,prezzoCarta:r.prezzoCarta||0,giacenza:0,lots:[]};
        wines=[...wines,newWine];
        wine=wines[wines.length-1];
      }

      const pAcq=parseFloat(r.prezzoAcq)||parseFloat(wine.prezzoAcq)||0;
      const newLot={id:uid(),data:dataArrivo,fattura,fornitore:fornitureName||wine.distributore||"",
        prezzoAcq:pAcq,iva:r.iva||wine.iva||22,qtyCaricata:qty,qtyRimanente:qty};

      // Traccia variazione prezzo e aggiorna immutabilmente
      const trackedGlob=_trackPriceChange(wine, pAcq, null, 'ricezione_globale');
      const updatedWine={
        ...trackedGlob,
        distributore: wine.distributore || fornitureName,
        giacenza:(parseInt(wine.giacenza)||0)+qty,
        prezzoAcq:pAcq,
        lots:[...(wine.lots||[]),newLot],
      };
      wines=wines.map(w=>w.id===updatedWine.id?updatedWine:w);
      wine=updatedWine;

      newMovsGlob.push({id:uid(),wineId:wine.id,wineName:wine.nome,produttore:wine.produttore,nazione:wine.nazione||"",
        tipo:"carico",qty,data:dataArrivo,fattura,prezzoAcqLotto:pAcq,
        fornitore:fornitureName,note:"Da ordine "+ordine.dataOrdine,ts:Date.now()});
      totRef++;
    });
    // Mutazione locale accettabile sull'oggetto ordine (non è nell'array wines)
    ordine.stato="caricato";
    ordine.dataArrivo=dataArrivo;
    ordine.dataCarico=today();
    if(fattura) ordine.numeroFattura=fattura;
  });
  movements=[...newMovsGlob,...movements];
  scheduleSave();
  // PATCH: flush immediato — ricezione globale è irreversibile
  clearTimeout(saveTimer);
  _flushSave();
  chiudiRicezioneGlobale();
  notify(`✅ ${selezionati.length} ordini (${totRef} referenze) caricati in magazzino!`);
  render();
}

function toggleOrdineArrivato(id,checked){
  const row=document.getElementById("ord-row-"+id);
  if(row) row.classList.toggle("lot-active",checked);
}

function deleteOrdine(id){
  // Cerca prima in orders locali, poi nelle bozze remote
  const o=orders.find(x=>x.id===id) || _bozzeSb.find(b=>b.id===id);
  if(!o) return;
  if(o.stato==="caricato"){notify("Gli ordini evasi non possono essere eliminati","err");return;}
  _confirmModal(
    `Eliminare l'ordine <strong>${o.fornitore||o.distributore||'—'}</strong> del ${o.dataOrdine||o.data_ordine||'—'}?`,
    "🗑️ Elimina",
    async ()=>{
      orders=orders.filter(x=>x.id!==id);
      if(_bozzeSb.some(b=>b.id===id)){
        _bozzeSb=_bozzeSb.filter(b=>b.id!==id);
        if(_sb) await _sb.from('ordini_testata').delete().eq('id',id);
      }
      scheduleSave(); render();
    },
    'danger'
  );
}

function _getOrdineById(id){
  if(!id) {
    // Se chiamato dalla modale senza id salvato (ordine nuovo non ancora salvato), usa ordineModalData
    if(ordineModalData && ordineModalData.referenze) return {
      id: 'preview',
      fornitore: document.getElementById("omd-fornitore")?.value || ordineModalData.fornitore || "—",
      dataOrdine: document.getElementById("omd-data")?.value || ordineModalData.dataOrdine || today(),
      note: document.getElementById("omd-note")?.value || ordineModalData.note || "",
      referenze: ordineModalData.referenze
    };
    return null;
  }
  const found = orders.find(o => o.id === id);
  if(found) return found;
  // Fallback: bozza remota non ancora promossa (usata da stampa/email senza aprire prima la modale)
  const bozza = _bozzeSb.find(b => b.id === id);
  if(bozza) return {
    id: bozza.id,
    fornitore: bozza.distributore || '—',
    dataOrdine: bozza.data_ordine || today(),
    note: bozza.note || '',
    stato: 'attesa',
    referenze: (bozza.righe||[]).map(r=>({
      id: r.id, wineId: r.wine_id,
      nomeVino: r.nome_vino||'', produttore: r.produttore||'',
      annata: r.annata||'', tipologia: r.tipologia||'Rosso',
      prezzoAcq: r.prezzo_acq||0, iva: r.iva||22,
      qty: r.qty_ordinata||1, formato: r.formato||0.75,
      regione: r.regione||'', zona: r.zona||'', nazione: r.nazione||'Italia',
      prezzoCarta: r.prezzo_carta||''
    }))
  };
  return null;
}

// ─── DATI LOCALE + EMAIL FORNITORI ───────────────────────────────────────────
// localeData: dati del ristorante/osteria — usati in stampaOrdine, emailOrdine
// e nella sezione Impostazioni. Persistiti in localStorage.
function _loadLocale(){ const _def={nome:"",indirizzo:"",cap:"",citta:"",provincia:"",piva:"",cf:"",sdi:"",pec:"",email:"",telefono:"",noteConsegna:""}; try{ const s=localStorage.getItem("cm_locale"); return s?{..._def,...JSON.parse(s)}:_def; }catch{ return _def; } }
function _saveLocale(d){ try{ localStorage.setItem("cm_locale",JSON.stringify(d)); }catch{} }
let localeData = _loadLocale();

// Rubrica email fornitori — oggetto {nome_fornitore_lowercase: "email@..."}
function _loadFornEmails(){ try{ const s=localStorage.getItem("cm_forn_emails"); return s?JSON.parse(s):{}; }catch{ return {}; } }
function _saveFornEmails(obj){ try{ localStorage.setItem("cm_forn_emails",JSON.stringify(obj)); }catch{} }
let _fornEmails = _loadFornEmails();
function _getFornEmail(forn){ return _fornEmails[(forn||"").toLowerCase().trim()]||""; }
function _setFornEmail(forn, email){ _fornEmails[(forn||"").toLowerCase().trim()]=email.trim(); _saveFornEmails(_fornEmails); }
function _getAllFornEmails(){ return _fornEmails; }

// Rubrica telefoni fornitori
function _loadFornTelefoni(){ try{ const s=localStorage.getItem("cm_forn_tel"); return s?JSON.parse(s):{}; }catch{ return {}; } }
function _saveFornTelefoni(obj){ try{ localStorage.setItem("cm_forn_tel",JSON.stringify(obj)); }catch{} }
let _fornTelefoni = _loadFornTelefoni();
function _getFornTelefono(forn){ return _fornTelefoni[(forn||"").toLowerCase().trim()]||""; }
function _setFornTelefono(forn, tel){ _fornTelefoni[(forn||"").toLowerCase().trim()]=tel.trim(); _saveFornTelefoni(_fornTelefoni); }
function _getAllFornTelefoni(){ return _fornTelefoni; }

// Converte numero telefono in formato wa.me (solo cifre + eventuale +)
function _waNum(tel){ return (tel||"").replace(/[\s\-().]/g,""); }

function stampaOrdine(id) {
  const o = _getOrdineById(id);
  if(!o){ notify("Salva prima l'ordine per stamparlo","err"); return; }
  const ref = o.referenze || [];
  const scontoOrd = parseFloat(o.sconto)||0;
  const totQty = ref.reduce((s,r) => s+(parseInt(r.qty)||0), 0);

  // Calcola totali considerando sia scontoRef che scontoOrd
  let totLordo=0, totNetto=0;
  ref.forEach(r=>{
    const pIva=(parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100);
    const lordo=pIva*(parseInt(r.qty)||0);
    const scontoRef=parseFloat(r.scontoRef)||0;
    const fattore=(1-scontoRef/100)*(1-scontoOrd/100);
    totLordo+=lordo;
    totNetto+=lordo*fattore;
  });
  const importoScontoTot=totLordo-totNetto;
  const hasAnyDiscount=importoScontoTot>0.001;

  // Mostra colonna Sc.% e Netto riga solo se almeno una referenza ha sconto o c'è sconto ordine
  const hasRefDiscount=ref.some(r=>parseFloat(r.scontoRef)>0);
  const showExtraCol=hasRefDiscount||scontoOrd>0;

  const righe = ref.map(r => {
    const pIva = (parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100);
    const tot = pIva*(parseInt(r.qty)||0);
    const scontoRef=parseFloat(r.scontoRef)||0;
    const fattore=(1-scontoRef/100)*(1-scontoOrd/100);
    const totNettaRiga=tot*fattore;
    const isOmaggio=scontoRef>=100;
    const scLabel=scontoRef>0?(isOmaggio?'🎁 100%':`${scontoRef}%`):(scontoOrd>0?`ord.${scontoOrd}%`:'—');
    return `<tr>
      <td>${h(r.produttore||'—')}</td>
      <td>${h(r.nomeVino)}</td>
      <td>${h(r.vitigni||'—')}</td>
      <td style="text-align:center">${h(r.annata||'—')}</td>
      <td>${h(r.tipologia||'—')}</td>
      <td>${h(r.regione||'—')}</td>
      <td>${h(r.nazione||'—')}</td>
      <td style="text-align:right">${r.prezzoAcq ? '€ '+parseFloat(r.prezzoAcq).toFixed(2) : '—'}</td>
      <td style="text-align:center">${r.iva||22}%</td>
      <td style="text-align:right">${pIva ? '€ '+pIva.toFixed(2) : '—'}</td>
      <td style="text-align:center;font-weight:600">${r.qty||0}</td>
      <td style="text-align:right;font-weight:600">${isOmaggio?'<span style="color:#1a6b35">OMAGGIO</span>':tot?'€ '+tot.toFixed(2):'—'}</td>
      ${showExtraCol?`<td style="text-align:center;font-size:10px;color:#c0392b">${scLabel}</td><td style="text-align:right;font-weight:600;color:#1a6b35">${isOmaggio?'€ 0.00':totNettaRiga?'€ '+totNettaRiga.toFixed(2):'—'}</td>`:''}
    </tr>`;
  }).join("");

  const scontoColHead = showExtraCol ? `<th class="c">Sc.%</th><th class="r">Netto riga</th>` : '';
  const colspan=showExtraCol?14:12;
  const scontoTfootRows = hasAnyDiscount ? `
    <tr style="background:#fff8e1">
      <td colspan="${colspan-2}" style="text-align:right;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#888">Sconti totali (righe + ordine)</td>
      <td style="text-align:center;color:#c0392b">${totQty} bt</td>
      <td style="text-align:right;color:#c0392b">− € ${importoScontoTot.toFixed(2)}</td>
    </tr>
    <tr>
      <td colspan="${colspan-2}" style="text-align:right;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#666;font-weight:700">TOTALE NETTO</td>
      <td style="text-align:center;font-weight:700">${totQty} bt</td>
      <td style="text-align:right;font-weight:700">€ ${totNetto.toFixed(2)}</td>
    </tr>` : '';

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
  <title>Ordine ${h(o.fornitore)} — ${h(o.dataOrdine)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#1a1a1a;padding:32px 40px;background:#fff}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:16px;border-bottom:2px solid #1a1a1a}
    .brand{font-size:18px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
    .brand-sub{font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:#888;margin-top:3px}
    .order-meta{text-align:right}
    .order-meta h2{font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
    .meta-grid{display:grid;grid-template-columns:auto auto;gap:3px 16px;font-size:10px}
    .meta-label{color:#888;text-align:right}
    .meta-val{font-weight:600}
    table{width:100%;border-collapse:collapse;margin-bottom:20px}
    thead tr{background:#1a1a1a;color:#fff}
    thead th{padding:7px 8px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;text-align:left;white-space:nowrap}
    thead th.r{text-align:right}
    thead th.c{text-align:center}
    tbody tr:nth-child(even){background:#f7f7f7}
    tbody td{padding:6px 8px;border-bottom:1px solid #e8e8e8;vertical-align:middle}
    tfoot tr{background:#f0f0f0;font-weight:700}
    tfoot td{padding:8px;border-top:2px solid #1a1a1a}
    .total-box{text-align:right;margin-top:8px;padding:14px 20px;background:#f7f7f7;border:1px solid #ddd;display:inline-block;float:right}
    .total-label{font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#888;margin-bottom:4px}
    .total-val{font-size:20px;font-weight:700}
    .note{margin-top:32px;clear:both;padding-top:16px;border-top:1px solid #ddd;font-size:10px;color:#888}
    .footer{margin-top:40px;padding-top:12px;border-top:1px solid #ddd;font-size:9px;color:#aaa;display:flex;justify-content:space-between}
    @media print{body{padding:16px 20px}@page{margin:1cm}}
  </style></head><body>
  <div class="header">
    <div>
      <div class="brand">🍷 ${localeData.nome||NOME_LOCALE}</div>
      <div class="brand-sub">${(()=>{const a=[localeData.indirizzo,[localeData.cap,localeData.citta,localeData.provincia?'('+localeData.provincia+')':''].filter(Boolean).join(' ')].filter(Boolean).join(', ');return a||'Gestione Cantina';})()}</div>
      ${localeData.piva?`<div style="font-size:9px;color:#888;margin-top:2px">P.IVA: ${localeData.piva}${localeData.cf?' &middot; C.F.: '+localeData.cf:''}</div>`:''}
      ${(localeData.email||localeData.telefono)?`<div style="font-size:9px;color:#888">${[localeData.email,localeData.telefono].filter(Boolean).join(' &middot; ')}</div>`:''}
      ${localeData.noteConsegna?`<div style="font-size:9px;color:#888;margin-top:4px;max-width:280px"><strong>Consegna:</strong> ${localeData.noteConsegna}</div>`:''}
    </div>
    <div class="order-meta">
      <h2>Ordine Fornitore</h2>
      <div class="meta-grid">
        <span class="meta-label">Fornitore</span><span class="meta-val">${h(o.fornitore||'—')}</span>
        <span class="meta-label">Data ordine</span><span class="meta-val">${h(o.dataOrdine)}</span>
        <span class="meta-label">N° referenze</span><span class="meta-val">${ref.length}</span>
        ${sconto>0?`<span class="meta-label">Sconto</span><span class="meta-val" style="color:#c0392b">${sconto}%</span>`:''}
        ${o.note?`<span class="meta-label">Note</span><span class="meta-val">${h(o.note)}</span>`:''}
      </div>
    </div>
  </div>
  <table>
    <thead><tr>
      <th>Produttore</th><th>Nome Vino</th><th>Vitigni</th>
      <th class="c">Annata</th><th>Tipologia</th><th>Regione</th><th>Nazione</th>
      <th class="r">P.Acq excl.</th><th class="c">IVA</th><th class="r">P.Acq+IVA</th>
      <th class="c">Qty</th><th class="r">Totale lordo</th>${scontoColHead}
    </tr></thead>
    <tbody>${righe}</tbody>
    <tfoot>
      <tr>
        <td colspan="${colspan-2}" style="text-align:right;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#666">Totale lordo IVA incl.</td>
        <td style="text-align:center">${totQty} bt</td>
        <td style="text-align:right">€ ${totLordo.toFixed(2)}</td>
      </tr>
      ${scontoTfootRows}
    </tfoot>
  </table>
  <div class="total-box">
    <div class="total-label">${sconto>0?'Totale Netto':'Totale IVA inclusa'}</div>
    <div class="total-val">€ ${(sconto>0?totNetto:totLordo).toFixed(2)}</div>
    ${sconto>0?`<div style="font-size:9px;color:#c0392b;margin-top:2px">Sconto ${sconto}% (− € ${importoSconto.toFixed(2)})</div>`:''}
    <div style="font-size:9px;color:#888;margin-top:4px">${totQty} bottiglie · ${ref.length} referenze</div>
  </div>
  <div class="note">
    ${o.note ? `<strong>Note:</strong> ${h(o.note)}<br>` : ''}
    Documento generato il ${new Date().toLocaleDateString('it-IT')} — Cantina Manager
  </div>
  <div class="footer">
    <span>${NOME_LOCALE} — Ordine del ${h(o.dataOrdine)}</span>
    <span>Fornitore: ${h(o.fornitore||'—')}</span>
  </div>
  <script>window.onload=function(){window.print();}<\/script>
  </body></html>`;

  const win = window.open('','_blank','width=1000,height=750');
  if(win){ win.document.write(html); win.document.close(); }
  else notify("⚠️ Pop-up bloccato — abilita i pop-up per questo sito","err");
}

async function emailOrdine(id) {
  const o = _getOrdineById(id);
  if(!o){ notify("Salva prima l'ordine per inviarlo","err"); return; }
  const ref = o.referenze || [];
  const scontoOrd = parseFloat(o.sconto)||0;
  const totQty = ref.reduce((s,r) => s+(parseInt(r.qty)||0), 0);
  let totLordo=0, totNetto=0;
  ref.forEach(r=>{ const l=(parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100)*(parseInt(r.qty)||0); const sr=parseFloat(r.scontoRef)||0; totLordo+=l; totNetto+=l*(1-sr/100)*(1-scontoOrd/100); });
  const importoSconto = totLordo-totNetto;

  const righeText = ref.map((r,i) => {
    const pIva = (parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100);
    const totRiga = pIva*(r.qty||0);
    const scontoRef=parseFloat(r.scontoRef)||0;
    const fattore=(1-scontoRef/100)*(1-scontoOrd/100);
    const totRigaNetto = totRiga*fattore;
    const isOmaggio=scontoRef>=100;
    return `${i+1}. ${r.produttore||'—'} — ${r.nomeVino}${r.annata?' ('+r.annata+')':''}`
      + `\n   Tipologia: ${r.tipologia||'—'} | Regione: ${r.regione||'—'} | Nazione: ${r.nazione||'—'}`
      + `\n   P.Acq: € ${parseFloat(r.prezzoAcq||0).toFixed(2)} + IVA ${r.iva||22}% = € ${pIva.toFixed(2)}/bt`
      + (isOmaggio
          ? `\n   Quantità: ${r.qty||0} bottiglie — OMAGGIO (100%)`
          : `\n   Quantità: ${r.qty||0} bottiglie — Lordo: € ${totRiga.toFixed(2)}`
            + (scontoRef>0||scontoOrd>0 ? ` → Netto: € ${totRigaNetto.toFixed(2)}`+(scontoRef>0?` (sc.ref ${scontoRef}%`+(scontoOrd>0?`+ord ${scontoOrd}%`:'')+')':'') : ''))
      + (r.note ? `\n   Note: ${r.note}` : '');
  }).join('\n\n');

  const subject = encodeURIComponent(`Ordine del ${o.dataOrdine} — ${NOME_LOCALE}`);
  const hasDiscount=importoSconto>0.001;
  const scontoBlock = hasDiscount
    ? `Totale lordo IVA incl.: € ${totLordo.toFixed(2)}\nSconti totali: − € ${importoSconto.toFixed(2)}\nTOTALE NETTO: € ${totNetto.toFixed(2)}\n`
    : `TOTALE IVA INCLUSA: € ${totLordo.toFixed(2)}\n`;
  const body = encodeURIComponent(
    `Gentili ${o.fornitore||'Fornitori'},\n\n` +
    `Vi inviamo il nostro ordine del ${o.dataOrdine}:\n\n` +
    `══════════════════════════════════\n` +
    `ORDINE FORNITORE — ${o.dataOrdine}\n` +
    `══════════════════════════════════\n\n` +
    righeText +
    `\n\n──────────────────────────────────\n` +
    `RIEPILOGO: ${ref.length} referenze · ${totQty} bottiglie\n` +
    (hasDiscount ? `Totale lordo IVA incl.: € ${totLordo.toFixed(2)}\n` : '') +
    scontoBlock +
    `──────────────────────────────────\n` +
    (o.note ? `\nNote: ${o.note}\n` : '') +
    `\nCordiali saluti,\n${NOME_LOCALE}`
  );

  const fornEmail=_getFornEmail(o.fornitore||"");
  const loc=_loadLocale();
  const addrLine=[loc.cap,loc.citta,loc.provincia?"("+loc.provincia+")":""].filter(Boolean).join(" ");
  const mittente=[
    loc.nome||NOME_LOCALE,
    loc.indirizzo?(loc.indirizzo+(addrLine?" — "+addrLine:"")):"",
    loc.piva?"P.IVA: "+loc.piva:"",
    loc.cf?"C.F.: "+loc.cf:"",
    loc.sdi?"SDI: "+loc.sdi:"",
    loc.pec?"PEC: "+loc.pec:"",
    loc.email?"Email: "+loc.email:"",
    loc.telefono?"Tel: "+loc.telefono:""
  ].filter(Boolean).join("\n");
  const consegnaBlock=loc.noteConsegna?"\n\n──────────────────────────────────\nINDICAZIONI CONSEGNA:\n"+loc.noteConsegna:"";
  const fullBody=encodeURIComponent(decodeURIComponent(body)+consegnaBlock+"\n\n──────────────────────────────────\n"+mittente);
  if(_sb && saveTimer){ clearTimeout(saveTimer); await _flushSave(); }
  window.location.href=`mailto:${encodeURIComponent(fornEmail)}?subject=${subject}&body=${fullBody}`;
  const _oe = orders.find(x => x.id === id);
  if(_oe){ _oe.inviatoVia = _oe.inviatoVia === 'whatsapp' ? 'entrambi' : 'email'; _oe.dataInvio = _oe.dataInvio || today(); scheduleSave(); render(); }
}

function whatsappOrdine(id) {
  const o = _getOrdineById(id);
  if(!o){ notify("Salva prima l'ordine per inviarlo","err"); return; }

  const tel = _getFornTelefono(o.fornitore||"");
  const ref = o.referenze || [];
  const scontoOrd = parseFloat(o.sconto)||0;
  const totQty = ref.reduce((s,r) => s+(parseInt(r.qty)||0), 0);
  let totLordo=0, totNetto=0;
  ref.forEach(r=>{ const l=(parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100)*(parseInt(r.qty)||0); const sr=parseFloat(r.scontoRef)||0; totLordo+=l; totNetto+=l*(1-sr/100)*(1-scontoOrd/100); });
  const hasAnyDiscount=totLordo>totNetto+0.001;
  const loc = _loadLocale();

  const righeWa = ref.map((r,i) => {
    const scontoRef=parseFloat(r.scontoRef)||0;
    const isOmaggio=scontoRef>=100;
    const scTag=isOmaggio?' 🎁 OMAGGIO':scontoRef>0?` (−${scontoRef}%)`:'';
    return `${i+1}. *${r.produttore||'—'} — ${r.nomeVino}*${r.annata?' ('+r.annata+')':''} × ${r.qty||0} bt${scTag}`;
  }).join('\n');

  const mittente = [loc.nome||NOME_LOCALE, loc.telefono?'Tel: '+loc.telefono:''].filter(Boolean).join(' · ');
  const consegna = loc.noteConsegna ? '\n\n📦 *Consegna:* '+loc.noteConsegna : '';
  const totaleWa = hasAnyDiscount
    ? `*Lordo: ${fmt(totLordo)}* — sconti applicati → *Netto: ${fmt(totNetto)}* · ${totQty} bottiglie`
    : `*Totale: ${totQty} bottiglie*`;

  const testo =
    `Gentili ${o.fornitore||'Fornitori'},\n\n` +
    `Vi inviamo il nostro ordine del *${o.dataOrdine}*:\n\n` +
    righeWa +
    `\n\n${totaleWa}` +
    (o.note ? `\n📝 Note: ${o.note}` : '') +
    consegna +
    `\n\nCordiali saluti,\n${mittente}`;

  const url = `https://wa.me/${tel?_waNum(tel):''}?text=${encodeURIComponent(testo)}`;

  if(!tel){
    notify("⚠️ Nessun telefono per questo fornitore — aggiungi il numero in Impostazioni → Rubrica Fornitori","err");
    window.open(`https://web.whatsapp.com/send?text=${encodeURIComponent(testo)}`,'_blank');
    const _owb = orders.find(x => x.id === id);
    if(_owb){ _owb.inviatoVia = _owb.inviatoVia === 'email' ? 'entrambi' : 'whatsapp'; _owb.dataInvio = _owb.dataInvio || today(); scheduleSave(); render(); }
    return;
  }
  window.open(url, '_blank');
  const _ow = orders.find(x => x.id === id);
  if(_ow){ _ow.inviatoVia = _ow.inviatoVia === 'email' ? 'entrambi' : 'whatsapp'; _ow.dataInvio = _ow.dataInvio || today(); scheduleSave(); render(); }
}

function _pulisciDateOrdiniImportati(){
  // S7/S8 FIX: la soglia non è più hardcoded. L'utente indica la data limite
  // oltre la quale le date sono considerate reali (non da import automatico).
  // Default = oggi, così "pulisci" rimuove date di arrivo/carico future sospette.
  const defaultSoglia = today();
  const input = prompt(
    "Rimuovi date arrivo/carico sospette dagli ordini NON ancora caricati.\n\n" +
    "Inserisci la data limite (YYYY-MM-DD).\n" +
    "Verranno azzerate le date ≤ questa data sugli ordini con stato 'attesa'.\n\n" +
    "Lascia vuoto per usare oggi come soglia.",
    defaultSoglia
  );
  if(input === null) return; // annullato
  const soglia = (input.trim() || defaultSoglia);
  // Validazione formato data
  if(!/^\d{4}-\d{2}-\d{2}$/.test(soglia)){
    notify("⚠️ Formato data non valido (usa YYYY-MM-DD)","err");
    return;
  }
  let n = 0;
  orders = orders.map(o => {
    const updated = {...o};
    let changed = false;
    // Se dataArrivo ≤ soglia e l'ordine NON è stato ricevuto tramite ricezione reale → pulisci
    if(o.dataArrivo && o.dataArrivo <= soglia && o.stato !== "caricato") {
      updated.dataArrivo = "";
      changed = true;
    }
    // Se dataCarico ≤ soglia su ordini non caricati → pulisci
    if(o.dataCarico && o.dataCarico <= soglia && o.stato !== "caricato") {
      updated.dataCarico = "";
      changed = true;
    }
    if(changed) n++;
    return updated;
  });
  if(n > 0){ scheduleSave(); render(); notify(`✅ Corrette le date su ${n} ordin${n===1?"e":"i"} (soglia: ${soglia})`); }
  else notify(`Nessuna data da correggere trovata con soglia ${soglia}`);
}

function exportStoricoOrdiniCSV(){
  const evasi=orders.filter(o=>o.stato==="caricato");
  if(!evasi.length){notify("Nessun ordine evaso","err");return;}
  const rows=[["Data Ordine","Fornitore","Produttore","Nome Vino","Tipologia","Prezzo Acq","IVA","Qty Ord.","Qty Arrivata","Data Arrivo","Fattura","Data Carico"]];
  evasi.forEach(o=>(o.referenze||[]).forEach(r=>rows.push([
    o.dataOrdine,o.fornitore||"",r.produttore||"",r.nomeVino,r.tipologia,r.prezzoAcq,(r.iva||22)+"%",r.qty,r.qtyArr??r.qty,o.dataArrivo||"",o.numeroFattura||"",o.dataCarico||""
  ])));
  const csv=rows.map(r=>r.map(v=>'"'+String(v||"").replace(/"/g,'""')+'"').join(",")).join("\n");
  const a=document.createElement("a");
  a.href="data:text/csv;charset=utf-8,﻿"+encodeURIComponent(csv);
  a.download="storico_ordini_"+today()+".csv";
  a.click();
  notify("CSV storico esportato");
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
// ─── IMPOSTAZIONI LOCALE ─────────────────────────────────────────────────────
function renderImpostazioni(){
  const d=localeData;
  const emails=_getAllFornEmails();
  const forniTel=_getAllFornTelefoni();
  const fornitori=[...new Set([...wines.map(w=>w.distributore),...orders.map(o=>o.fornitore)].filter(Boolean))].sort();
  const fornRighe = fornitori.length===0
    ? '<div style="text-align:center;padding:28px;color:var(--txt4);font-size:11px">Nessun fornitore trovato — aggiungilo tramite un ordine</div>'
    : `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--txt4);padding:0 0 6px;border-bottom:1px solid var(--border);margin-bottom:8px"><span>Fornitore</span><span>Email</span><span>Telefono / WhatsApp</span></div>
<div style="display:flex;flex-direction:column;gap:8px">${fornitori.map(f=>{
  const fk=(f||'').toLowerCase().trim();
  const fe=h(emails[fk]||'');
  const ft=h(forniTel[fk]||'');
  const fh=h(f);
  const waBtn=forniTel[fk]?`<a href="https://wa.me/${_waNum(forniTel[fk])}" target="_blank" title="Apri WhatsApp" style="flex-shrink:0;display:flex;align-items:center;justify-content:center;width:30px;height:30px;background:rgba(37,211,102,.15);border:1px solid rgba(37,211,102,.3);border-radius:6px;font-size:15px;text-decoration:none">🟢</a>`:'';
  return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;align-items:center">
    <span style="font-size:12px;color:var(--txt2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${fh}">${fh}</span>
    <input class="form-input" style="font-size:11px" placeholder="email@fornitore.it" value="${fe}" onchange="_setFornEmail('${fh}',this.value);notify('✓ Email salvata')">
    <div style="display:flex;gap:4px;align-items:center"><input class="form-input" style="font-size:11px;flex:1" placeholder="+39 333 1234567" value="${ft}" onchange="_setFornTelefono('${fh}',this.value);notify('✓ Telefono salvato')">${waBtn}</div>
  </div>`;
}).join('')}</div>`;
  return `<div class="kpi-grid g2" style="gap:20px">
    <div class="card">
      <div class="section-label"><span>🏠 Dati del Locale</span></div>
      <div class="form-grid g2">
        <div class="col-span-2"><label class="form-label">Nome Locale</label><input class="form-input" id="loc-nome" value="${h(d.nome)}" placeholder="Osteria Lagrandissima"></div>
        <div class="col-span-2"><label class="form-label">Indirizzo</label><input class="form-input" id="loc-indirizzo" value="${h(d.indirizzo)}" placeholder="es. Via Roma 1"></div>
        <div><label class="form-label">CAP</label><input class="form-input" id="loc-cap" value="${h(d.cap)}" placeholder="20100"></div>
        <div><label class="form-label">Città</label><input class="form-input" id="loc-citta" value="${h(d.citta)}" placeholder="Milano"></div>
        <div><label class="form-label">Provincia</label><input class="form-input" id="loc-provincia" value="${h(d.provincia)}" placeholder="MI"></div>
        <div><label class="form-label">Email locale</label><input class="form-input" id="loc-email" value="${h(d.email)}" placeholder="info@osteria.it"></div>
        <div><label class="form-label">Telefono</label><input class="form-input" id="loc-telefono" value="${h(d.telefono)}" placeholder="+39 02 1234567"></div>
      </div>
      <div class="section-label" style="margin-top:20px"><span>🧾 Dati Fatturazione</span></div>
      <div class="form-grid g2">
        <div><label class="form-label">Partita IVA</label><input class="form-input" id="loc-piva" value="${h(d.piva)}" placeholder="IT12345678901"></div>
        <div><label class="form-label">Codice Fiscale</label><input class="form-input" id="loc-cf" value="${h(d.cf)}" placeholder="Codice fiscale società"></div>
        <div><label class="form-label">Codice SDI <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— per fatture elettroniche</span></label><input class="form-input" id="loc-sdi" value="${h(d.sdi||'')}" placeholder="es. ABC1234"></div>
        <div><label class="form-label">PEC <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— alternativa a SDI</span></label><input class="form-input" id="loc-pec" value="${h(d.pec||'')}" placeholder="es. azienda@pec.it"></div>
      </div>
      <div class="section-label" style="margin-top:20px"><span>🚚 Indicazioni Consegna</span></div>
      <textarea class="form-input" id="loc-noteConsegna" rows="4" style="resize:vertical" placeholder="es. Consegnare martedì 8–12. Suonare citofono Cucina. Ingresso merci su Via Verdi.">${h(d.noteConsegna)}</textarea>
      <button class="btn-primary" style="margin-top:16px;width:100%;justify-content:center" onclick="salvaImpostazioni()">💾 Salva Impostazioni</button>
    </div>
    <div class="card">
      <div class="section-label"><span>📋 Rubrica Fornitori</span></div>
      <p style="font-size:11px;color:var(--txt4);margin-bottom:16px;line-height:1.6">Email e telefono di ogni fornitore. L'email si compila in automatico nell'ordine; il 🟢 apre WhatsApp direttamente.</p>
      ${fornRighe}
      ${fornitori.length>0?'<div style="margin-top:14px;padding:10px 12px;background:rgba(0,122,255,.08);border:1px solid rgba(0,122,255,.2);font-size:10px;color:var(--txt3);line-height:1.6">💡 Formato telefono internazionale: <strong>+39 333 1234567</strong>. Il tasto 🟢 apre WhatsApp Web o l\'app mobile.</div>':''}
    </div>
  </div>`;
}
function salvaImpostazioni(){
  localeData={
    nome:(document.getElementById("loc-nome")?.value||"").trim()||NOME_LOCALE,
    indirizzo:(document.getElementById("loc-indirizzo")?.value||"").trim(),
    cap:(document.getElementById("loc-cap")?.value||"").trim(),
    citta:(document.getElementById("loc-citta")?.value||"").trim(),
    provincia:(document.getElementById("loc-provincia")?.value||"").trim(),
    piva:(document.getElementById("loc-piva")?.value||"").trim(),
    cf:(document.getElementById("loc-cf")?.value||"").trim(),
    sdi:(document.getElementById("loc-sdi")?.value||"").trim(),
    pec:(document.getElementById("loc-pec")?.value||"").trim(),
    email:(document.getElementById("loc-email")?.value||"").trim(),
    telefono:(document.getElementById("loc-telefono")?.value||"").trim(),
    noteConsegna:(document.getElementById("loc-noteConsegna")?.value||"").trim(),
  };
  _saveLocale(localeData);
  notify("✅ Impostazioni salvate");
}


function renderExport(){
  const dateStr=new Date().toLocaleDateString("it-IT");
  const wineMap=Object.fromEntries(wines.map(w=>[w.id,w]));
  const carichi=movements.filter(m=>m.tipo==="carico");
  let totImponibileAcq=0,totIvaAcq=0;
  carichi.forEach(m=>{const w=wineMap[m.wineId];const p=parseFloat(m.prezzoAcqLotto)||parseFloat(w?.prezzoAcq)||0;const imp=p*m.qty;totImponibileAcq+=imp;totIvaAcq+=imp*((parseInt(w?.iva)||22)/100);});
  let totPerdite=0,totIvaPerd=0;
  fallate.forEach(f=>{const w=wineMap[f.wineId];const p=parseFloat(w?.prezzoAcq)||0;const vc=p*f.qty;totPerdite+=vc;totIvaPerd+=vc*((parseInt(w?.iva)||22)/100);});
  const totIvaStock=wines.reduce((s,w)=>s+calcValore(w)*((parseInt(w.iva)||22)/100),0);
  const s=getStats();

  let html=`<div class="card card-amber" style="margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px">
      <div><div style="font-size:10px;letter-spacing:.25em;text-transform:uppercase;color:var(--txt2);margin-bottom:4px">💾 Bilancio di Magazzino</div><div style="font-family:'Montserrat',sans-serif;font-weight:300;font-size:1.3rem;color:var(--txt)">Situazione al ${dateStr}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn-outline btn-sm" onclick="exportBackupJSON()" title="Backup completo di tutti i dati">💾 Backup JSON</button>
        <label class="btn-outline btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);font-size:11px;letter-spacing:.04em" title="Ripristina da file JSON">
          📥 Importa Backup
          <input type="file" accept=".json" onchange="importBackupJSON(event)" style="display:none">
        </label>
        <label class="btn-outline btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid rgba(59,130,246,.4);color:#93c5fd;font-size:11px;letter-spacing:.04em" title="Importa nazioni/regioni da file ODS/XLSX (match produttore+nome vino)">🌍 Aggiorna Nazioni<input type="file" accept=".ods,.xlsx,.xls" onchange="importNazioniDaFile(event)" style="display:none"></label>

        <button class="btn-outline btn-sm" onclick="openDuplicatiModal()" style="border-color:rgba(191,95,255,.4);color:#bf5fff" title="Trova e fondi vini duplicati nel database">🔍 Trova Duplicati</button>
        <button class="btn-primary" onclick="exportBilancioCSV()">↓ Esporta Bilancio Completo</button>
      </div>
    </div>
    <div class="bilancio-grid">
      ${["Voce","Qtà","Imponibile","IVA","Totale IVA incl."].map(hd=>`<div class="bilancio-cell bilancio-header">${hd}</div>`).join("")}
      <div class="bilancio-cell" style="color:#e7e5e4">Acquisti (carichi)</div>
      <div class="bilancio-cell" style="color:var(--amber)">${carichi.reduce((s,m)=>s+m.qty,0)} bt</div>
      <div class="bilancio-cell" style="color:var(--amber)">${fmt(totImponibileAcq)}</div>
      <div class="bilancio-cell" style="color:var(--amber)">${fmt(totIvaAcq)}</div>
      <div class="bilancio-cell" style="color:var(--txt);font-weight:600">${fmt(totImponibileAcq+totIvaAcq)}</div>
      <div class="bilancio-cell" style="color:#e7e5e4">Perdite / Fallate</div>
      <div class="bilancio-cell" style="color:#FF453A">${fallate.reduce((s,f)=>s+f.qty,0)} bt</div>
      <div class="bilancio-cell" style="color:#FF453A">(${fmt(totPerdite)})</div>
      <div class="bilancio-cell" style="color:#ef4444">(${fmt(totIvaPerd)})</div>
      <div class="bilancio-cell" style="color:#FF6B6B;font-weight:600">(${fmt(totPerdite+totIvaPerd)})</div>
      <div class="bilancio-cell" style="color:#e7e5e4">Giacenza attuale</div>
      <div class="bilancio-cell" style="color:#30D158">${s.giacenzaTot} bt</div>
      <div class="bilancio-cell" style="color:#30D158">${fmt(s.valoreTot)}</div>
      <div class="bilancio-cell" style="color:#22c55e">${fmt(totIvaStock)}</div>
      <div class="bilancio-cell" style="color:#bbf7d0;font-weight:600">${fmt(s.valoreTot+totIvaStock)}</div>
      <div class="bilancio-cell" style="border-bottom:none;color:#e7e5e4">Potenziale di vendita</div>
      <div class="bilancio-cell" style="border-bottom:none;color:#007AFF">${s.giacenzaTot} bt</div>
      <div class="bilancio-cell" style="border-bottom:none;color:#007AFF">${fmt(s.valoreCarta)}</div>
      <div class="bilancio-cell" style="border-bottom:none;color:var(--txt4)">—</div>
      <div class="bilancio-cell" style="border-bottom:none;color:#bfdbfe;font-weight:600">${fmt(s.valoreCarta)}</div>
    </div>
  </div>
  <div class="kpi-grid g2">
    ${[
      {icon:"🗂️",tag:"A",title:"Giacenze al "+dateStr,desc:"Inventario fisico con giacenza, prezzo acquisto, IVA, valore costo e potenziale. Totali aggregati in calce.",badge:"background:rgba(255,159,10,.2);color:var(--amber);border-color:rgba(180,83,9,.5)",fn:"exportInventarioCSV()",label:"Esporta Giacenze CSV"},
      {icon:"📑",tag:"B",title:"Registro Acquisti",desc:"Ordine cronologico con n° fattura, fornitore, imponibile per riga, IVA assolta. Pronto per la contabilità.",badge:"background:rgba(30,64,175,.4);color:#93c5fd;border-color:rgba(37,99,235,.5)",fn:"exportAcquistiCSV()",label:"Esporta Acquisti CSV"},
      {icon:"⚠️",tag:"C",title:"Registro Perdite / Fallate",desc:"Perdite da scaricare a bilancio: valore costo, IVA su merce persa, totale perdita. Ordine cronologico.",badge:"background:rgba(255,69,58,.2);color:#FF6B6B;border-color:#CC3025",fn:"exportFallateCSV()",label:"Esporta Fallate CSV"},
      {icon:"↕️",tag:"D",title:"Tutti i Movimenti",desc:"Log completo carico e scarico con valore del movimento, riferimenti fattura e note.",badge:"background:var(--bg3);color:#e7e5e4;border-color:var(--border2)",fn:"exportMovimentiCSV()",label:"Esporta Movimenti CSV"},
    ].map(card=>`<div class="export-card"><div class="export-icon">${card.icon}</div><div style="flex:1"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span class="export-tag" style="${card.badge}">${card.tag}</span><span style="font-family:'Montserrat',sans-serif;font-size:13px;color:var(--txt)">${card.title}</span></div><p class="export-desc">${card.desc}</p><button class="btn-primary btn-sm" onclick="${card.fn}">↓ ${card.label}</button></div></div>`).join("")}
  </div>
  <div style="margin-top:20px;padding:16px 20px;background:var(--bg2);border:1px solid var(--border)">
    <div class="section-label"><span>📊 Ripartizione Valore al Costo per Tipologia</span></div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${TIPOLOGIE.filter(t=>wines.some(w=>w.tipologia===t)).map(t=>{
        const tw=wines.filter(w=>w.tipologia===t);
        const tv=tw.reduce((s,w)=>s+calcValore(w),0);
        const pct=s.valoreTot?(tv/s.valoreTot*100):0;
        const tvIva=tw.reduce((s2,w)=>s2+calcValore(w)*((parseInt(w.iva)||22)/100),0);
        return `<div style="display:flex;align-items:center;gap:12px">
          ${badge(t)}
          <div class="mini-bar" style="flex:1"><div class="mini-bar-fill" style="width:${pct}%"></div></div>
          <span style="color:var(--txt3);font-size:10px;width:60px;text-align:right">${tw.reduce((s3,w)=>s3+w.giacenza,0)} bt</span>
          <span style="color:var(--amber);font-size:11px;width:90px;text-align:right">${fmt(tv)}</span>
          <span style="color:var(--txt4);font-size:10px;width:100px;text-align:right">IVA ${fmt(tvIva)}</span>
          <span style="color:var(--txt4);font-size:10px;width:40px;text-align:right">${fmtN(pct,1)}%</span>
        </div>`;
      }).join("")}
    </div>
  </div>`;
  return html;
}

// ─── SCHEDA VINO — SOLA LETTURA ───────────────────────────────────────────────
// Pannello di consultazione rapida: mostra tutti i dati del vino, lotti,
// storico prezzi e movimenti recenti senza entrare in modalità modifica.
// Si apre con un doppio click sulla riga (o dal bottone 👁 futuro).
function openWineDetail(id){
  const w = wines.find(x=>x.id===id);
  if(!w) return;
  const mp = calcMarginePerc(w);
  const mb = calcMargineBottiglia(w);
  const costoIva = calcCostoIvaBottiglia(w);
  const sg = _getSoglie(id);
  const isEmpty = w.giacenza===0, isAlert = w.giacenza<=sg.min && !isEmpty;

  // Lotti attivi
  const lotsHtml = (w.lots||[]).length ? (() => {
    const attivi = [...w.lots].reverse().filter(l=>l.qtyRimanente>0);
    const esauriti = [...w.lots].reverse().filter(l=>l.qtyRimanente===0).slice(0,3);
    const all = [...attivi, ...esauriti];
    return `<div style="margin-top:20px">
      <div class="modal-section-label">📦 Lotti FIFO${attivi.length>0?` <span style="font-size:10px;color:#30D158;font-weight:400;letter-spacing:0;text-transform:none">${attivi.length} attivi</span>`:''}</div>
      <div style="display:grid;grid-template-columns:90px 80px 1fr 90px 70px 70px;gap:0;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt4);padding:6px 10px;background:rgba(41,37,36,.4)">
        <span>Data</span><span>Fattura</span><span>Fornitore</span><span style="text-align:right">P.Acq</span><span style="text-align:right">Caricato</span><span style="text-align:right">Rimanente</span>
      </div>
      ${all.map(l=>{const done=l.qtyRimanente===0;return `<div style="display:grid;grid-template-columns:90px 80px 1fr 90px 70px 70px;gap:0;padding:7px 10px;border-bottom:1px solid rgba(41,37,36,.5);font-size:11px;align-items:center;${done?'opacity:.5':''}">
        <span style="color:var(--txt3)">${l.data||'—'}</span>
        <span style="color:var(--txt3);overflow:hidden;text-overflow:ellipsis">${l.fattura||'—'}</span>
        <span style="color:var(--txt3);overflow:hidden;text-overflow:ellipsis">${l.fornitore||'—'}</span>
        <span style="text-align:right;color:var(--amber)">${fmt(l.prezzoAcq)}</span>
        <span style="text-align:right;color:var(--txt3)">${l.qtyCaricata} bt</span>
        <span style="text-align:right;${done?'color:var(--txt4);text-decoration:line-through':l.qtyRimanente<=3?'color:#fb923c':'color:#30D158'}">${l.qtyRimanente} bt</span>
      </div>`}).join('')}
      <div style="display:flex;justify-content:space-between;padding:8px 10px;border-top:1px solid var(--border);font-size:10px;color:var(--txt3)">
        <span>Prezzo medio ponderato lotti attivi</span>
        <span style="color:var(--amber)">${fmt(calcPrezzoMedioLotti(w))}/bt</span>
      </div>
    </div>`;
  })() : '';

  // Movimenti recenti (ultimi 6)
  const wMovs = [...movements].filter(m=>m.wineId===id).sort((a,b)=>b.data.localeCompare(a.data)||b.ts-a.ts).slice(0,6);
  const movsHtml = wMovs.length ? `<div style="margin-top:20px">
    <div class="modal-section-label">↕️ Movimenti Recenti</div>
    ${wMovs.map(m=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid rgba(41,37,36,.4);font-size:12px">
      <span style="color:${m.tipo==='carico'?'#30D158':'#FF453A'}">${m.tipo==='carico'?'⬆':'⬇'}</span>
      <span style="color:var(--txt3);width:88px;flex-shrink:0">${m.data||'—'}</span>
      <span style="flex:1;color:var(--txt3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.note||m.fattura||'—'}</span>
      <span style="font-family:'Montserrat',sans-serif;color:${m.tipo==='carico'?'#30D158':'#FF453A'}">${m.tipo==='carico'?'+':'-'}${m.qty}</span>
    </div>`).join('')}
  </div>` : '';

  // Storico prezzi
  const histHtml = w.priceHistory?.length ? `<div style="margin-top:20px">
    <div class="modal-section-label">📈 Storico Prezzi (ultimi ${Math.min(w.priceHistory.length,5)})</div>
    ${[...w.priceHistory].reverse().slice(0,5).map(e=>`<div style="display:flex;align-items:center;gap:12px;padding:6px 10px;border-bottom:1px solid rgba(41,37,36,.4);font-size:11px">
      <span style="color:var(--txt4);width:88px;flex-shrink:0">${e.data}</span>
      <span style="color:var(--txt3);flex:1;font-size:10px;letter-spacing:.06em;text-transform:uppercase">${e.source||'manuale'}</span>
      ${e.prezzoAcq!==e.prevAcq?`<span style="color:var(--amber)">Acq: ${fmt(e.prezzoAcq)}</span>`:''}
      ${e.prezzoCarta!==e.prevCarta?`<span style="color:#30D158">Carta: ${fmt(e.prezzoCarta)}</span>`:''}
    </div>`).join('')}
  </div>` : '';

  const giacenzaColor = isEmpty?'#FF453A':isAlert?'#fb923c':'var(--amber)';

  // Crea il modal se manca nel DOM (es. index.html non aggiornato)
  if (!document.getElementById('wine-detail-backdrop')) {
    const bd = document.createElement('div');
    bd.id = 'wine-detail-backdrop';
    bd.className = 'modal-backdrop hidden';
    // FIX: chiudi SOLO se il click è sul backdrop stesso, non su nessun figlio
    bd.addEventListener('click', e => { if(e.target === bd) closeWineDetail(); });
    bd.innerHTML = `<div class="modal" style="max-width:820px;width:calc(100% - 24px);overflow-y:auto;max-height:92dvh;overscroll-behavior:contain" onclick="event.stopPropagation()">
      <div class="modal-header" style="position:sticky;top:0;z-index:1;background:var(--bg2);border-bottom:1px solid var(--border)">
        <h2 id="wine-detail-title" style="font-size:clamp(13px,3.5vw,17px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">🍾 Scheda Vino</h2>
        <button style="font-size:22px;color:var(--txt3);background:none;border:none;cursor:pointer;padding:4px 8px;flex-shrink:0;line-height:1" onclick="closeWineDetail()" aria-label="Chiudi">✕</button>
      </div>
      <div class="modal-body" id="wine-detail-body" style="padding-bottom:8px"></div>
      <div class="modal-footer" style="position:sticky;bottom:0;z-index:1;background:var(--bg2);border-top:1px solid var(--border);gap:10px">
        <button class="btn-outline" onclick="closeWineDetail()">Chiudi</button>
        <button class="btn-primary" id="wine-detail-edit-btn" onclick="closeWineDetail();openWineModal(document.getElementById('wine-detail-backdrop').dataset.wineId)">✏️ Modifica</button>
      </div>
    </div>`;
    document.body.appendChild(bd);
  }
  // Popola il body DOPO che il nodo è nel DOM
  document.getElementById('wine-detail-body').innerHTML = `
    <!-- Header identità -->
    <div style="display:flex;align-items:flex-start;gap:20px;margin-bottom:24px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-family:'Montserrat',sans-serif;font-weight:600;font-size:1.3rem;color:var(--txt);margin-bottom:4px">${h(w.nome)}</div>
        <div style="font-size:13px;color:var(--txt2);margin-bottom:8px">${h(w.produttore)}${w.distributore?` <span style="color:var(--txt4);font-size:11px">via ${h(w.distributore)}</span>`:''}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          ${badge(w.tipologia)}
          ${w.annata?`<span style="color:var(--amber);font-family:'Montserrat',sans-serif;font-size:1rem">${h(w.annata)}</span>`:'<span style="color:var(--txt4);font-size:10px">N.V.</span>'}
          ${(parseFloat(w.formato)||0.75)>0.75?`<span style="font-size:10px;padding:2px 7px;border:1px solid rgba(0,122,255,.3);color:#60a5fa;background:rgba(0,122,255,.08);border-radius:4px">${w.formato}L</span>`:''}
          ${w.vitigni?`<span style="font-size:11px;color:var(--txt3)">🍇 ${h(w.vitigni)}</span>`:''}
        </div>
        ${(w.regione||w.nazione)?`<div style="margin-top:8px;font-size:11px;color:var(--txt3)">${[w.regione,w.zona,w.nazione].filter(Boolean).map((v,i)=>i===2?`<span style="color:var(--amber3);font-weight:600">${h(v)}</span>`:h(v)).join(' · ')}</div>`:''}
      </div>
      <!-- Giacenza big -->
      <div style="text-align:center;padding:16px 24px;background:rgba(255,159,10,.06);border:1px solid rgba(255,159,10,.2);border-radius:var(--radius);min-width:110px">
        <div style="font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt4);margin-bottom:6px">Giacenza</div>
        <div style="font-family:'Montserrat',sans-serif;font-weight:300;font-size:2.4rem;color:${giacenzaColor}">${w.giacenza}</div>
        <div style="font-size:9px;color:var(--txt4);margin-top:2px">bottiglie</div>
        ${isEmpty?`<div style="font-size:8px;color:#dc2626;text-transform:uppercase;letter-spacing:.08em;margin-top:4px">esaurito</div>`:''}
        ${isAlert?`<div style="font-size:8px;color:#ea580c;text-transform:uppercase;letter-spacing:.08em;margin-top:4px">scorta bassa (min ${sg.min})</div>`:''}
        ${w.noteVeloce?`<div style="margin-top:8px;font-size:10px;color:var(--amber);font-style:italic;text-align:left;max-width:120px">"${h(w.noteVeloce)}"</div>`:''}
      </div>
    </div>

    <!-- KPI prezzi -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
      <div style="background:var(--bg3);border:1px solid var(--border);padding:12px;border-radius:var(--radius-sm)">
        <div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:6px">P.Acquisto</div>
        <div style="font-family:'Montserrat',sans-serif;font-size:1.15rem;color:var(--amber)">${w.prezzoAcq?fmt(w.prezzoAcq):'—'}</div>
        <div style="font-size:10px;color:var(--txt4);margin-top:3px">IVA ${w.iva||22}% escl.</div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);padding:12px;border-radius:var(--radius-sm)">
        <div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:6px">Costo+IVA/bt</div>
        <div style="font-family:'Montserrat',sans-serif;font-size:1.15rem;color:var(--amber)">${costoIva?fmtRound(costoIva):'—'}</div>
        <div style="font-size:10px;color:var(--txt4);margin-top:3px">IVA inclusa</div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);padding:12px;border-radius:var(--radius-sm)">
        <div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:6px">P.Carta</div>
        <div style="font-family:'Montserrat',sans-serif;font-size:1.15rem;color:${w.prezzoCarta?'#30D158':'var(--txt4)'}">${w.prezzoCarta?fmt(w.prezzoCarta):'—'}</div>
        <div style="font-size:10px;color:var(--txt4);margin-top:3px">al cliente</div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);padding:12px;border-radius:var(--radius-sm);border-color:${mp!==null?(mp>=50?'rgba(48,209,88,.25)':mp>=30?'rgba(255,159,10,.25)':'rgba(255,69,58,.25)'):'var(--border)'}">
        <div style="font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--txt4);margin-bottom:6px">Margine %</div>
        <div style="font-family:'Montserrat',sans-serif;font-size:1.15rem;color:${mp===null?'var(--txt4)':mp>=50?'#30D158':mp>=30?'var(--amber)':'#FF453A'}">${mp===null?'—':`${fmtN(mp,1)}%`}</div>
        <div style="font-size:10px;color:var(--txt4);margin-top:3px">${mb!==null?fmt(mb)+'/bt':'—'}</div>
      </div>
    </div>

    ${lotsHtml}
    ${movsHtml}
    ${histHtml}
  `;
  document.getElementById('wine-detail-backdrop').dataset.wineId = id;
  document.getElementById('wine-detail-backdrop').classList.remove('hidden');
}
function closeWineDetail(){
  document.getElementById('wine-detail-backdrop')?.classList.add('hidden');
}

// ─── WINE MODAL ───────────────────────────────────────────────────────────────
function openWineModal(idOrNull){
  const wine=idOrNull?wines.find(w=>w.id===idOrNull):null;
  modalWine=wine;
  document.getElementById("modal-title").textContent=wine?"Modifica Vino":"Aggiungi Vino";
  document.getElementById("modal-body").innerHTML=renderModalBody(wine);
  // Bottone elimina: solo in modalità modifica
  let delBtn=document.getElementById("modal-delete-btn");
  if(wine){
    if(!delBtn){
      delBtn=document.createElement("button");
      delBtn.id="modal-delete-btn";
      delBtn.className="btn-danger";
      delBtn.style.marginRight="auto";
      delBtn.innerHTML="🗑️ Elimina vino";
      const footer=document.querySelector("#wine-modal .modal-footer");
      footer.insertBefore(delBtn,footer.firstChild);
    }
    delBtn.onclick=()=>{ closeWineModal(); deleteWine(wine.id); };
  } else {
    if(delBtn) delBtn.remove();
  }

  // FIX: assicura che il .modal interno blocchi la propagazione al backdrop,
  // indipendentemente da come è scritto index.html
  const backdrop = document.getElementById("wine-modal-backdrop");
  if(backdrop){
    // Rimuovi il vecchio handler onclick sull'backdrop e usa addEventListener
    // per poter filtrare correttamente solo i click sul backdrop stesso
    if(!backdrop._patchedClose){
      backdrop._patchedClose = true;
      backdrop.removeAttribute("onclick");
      backdrop.addEventListener("click", e => {
        if(e.target === backdrop) closeWineModal();
      });
    }
    // Assicura che il .modal figlio blocchi propagazione
    const innerModal = backdrop.querySelector(".modal");
    if(innerModal && !innerModal._patchedStop){
      innerModal._patchedStop = true;
      innerModal.addEventListener("click", e => e.stopPropagation());
    }
  }

  document.getElementById("wine-modal-backdrop").classList.remove("hidden");
  updateModalCalc();
}
function closeWineModal(e){
  if(e && e.target !== document.getElementById("wine-modal-backdrop")) return;
  document.getElementById("wine-modal-backdrop").classList.add("hidden");
  const delBtn=document.getElementById("modal-delete-btn"); if(delBtn) delBtn.remove();
}
function renderModalBody(wine){
  const f=wine||{nome:"",produttore:"",distributore:"",annata:"",vitigni:"",tipologia:"Rosso",regione:"",nazione:"Italia",zona:"",prezzoAcq:"",iva:22,prezzoCarta:"",prezzoCalice:"",giacenza:0};
  const lotsHtml=wine?.lots?.length?`
    <div style="margin-top:4px">
      <div class="modal-section-label">📦 Storico Lotti (FIFO)</div>
      <div class="lot-grid" style="color:var(--txt4);font-size:9px"><span>Data</span><span>Fattura</span><span>Fornitore</span><span style="text-align:right">P.Acq</span><span style="text-align:right">Caricato</span><span style="text-align:right">Rimanente</span></div>
      ${[...wine.lots].reverse().map(l=>{const done=l.qtyRimanente===0;return `<div class="lot-row ${done?"lot-done":"lot-active"}" style="margin-bottom:2px">
        <span>${l.data}</span><span style="overflow:hidden;text-overflow:ellipsis">${l.fattura||"—"}</span><span style="overflow:hidden;text-overflow:ellipsis;color:${done?"var(--txt4)":"var(--txt3)"}">${l.fornitore||"—"}</span>
        <span style="text-align:right;${done?"color:var(--txt4)":"color:var(--amber)"}">${fmt(l.prezzoAcq)}</span>
        <span style="text-align:right;color:var(--txt3)">${l.qtyCaricata} bt</span>
        <span style="text-align:right;${done?"color:var(--txt4);text-decoration:line-through":l.qtyRimanente<=3?"color:#fb923c":"color:#30D158"}">${l.qtyRimanente} bt</span>
      </div>`}).join("")}
      <div style="display:flex;justify-content:space-between;padding:8px 12px;border-top:1px solid var(--border);font-size:10px;color:var(--txt3)">
        <span>Prezzo medio ponderato lotti attivi</span>
        <span style="color:var(--amber)">${fmt(calcPrezzoMedioLotti(wine))}/bt</span>
      </div>
    </div>`:"";

  const FORMATI_OPTS = [
    {v:"0.375",l:"0.375 L (Mezza)"},{v:"0.75",l:"0.75 L (Standard)"},{v:"1.5",l:"1.5 L (Magnum)"},
    {v:"2.0",l:"2.0 L (Jeroboam)"},{v:"3.0",l:"3.0 L (Double Magnum)"},{v:"4.5",l:"4.5 L (Réhoboam)"},
    {v:"6.0",l:"6.0 L (Mathusalem)"},{v:"altro",l:"Altro formato"}
  ].map(x=>`<option value="${x.v}" ${(String(f.formato||"0.75"))===x.v?"selected":""}>${x.l}</option>`).join("");
  return `
    <div class="modal-section">
      <div class="modal-section-label">🍷 Identità del Vino</div>
      <div class="form-grid g2">
        <div><label class="form-label">Nome Vino *</label><input class="form-input" id="mf-nome" value="${h(f.nome)}" placeholder="es. Barolo Cannubi" oninput="updateModalCalc()"></div>
        <div><label class="form-label">Produttore *</label><input class="form-input" id="mf-produttore" value="${h(f.produttore)}" placeholder="es. Giacomo Conterno"></div>
        <div><label class="form-label">Distributore</label><input class="form-input" id="mf-distributore" value="${h(f.distributore)}" placeholder="es. Vini Italiani Srl"></div>
        <div><label class="form-label">Annata</label><input class="form-input" id="mf-annata" value="${h(f.annata)}" placeholder="es. 2019 o N.V."></div>
        <div><label class="form-label">Vitigni</label><input class="form-input" id="mf-vitigni" value="${h(f.vitigni)}" placeholder="es. Nebbiolo 100%"></div>
        <div><label class="form-label">Tipologia</label><select class="form-select" id="mf-tipologia" data-prev="${f.tipologia}" onchange="_addTipologiaInline(this);if(this.value!=='__new__'){this.dataset.prev=this.value}">${TIPOLOGIE.map(t=>`<option value="${t}" ${f.tipologia===t?"selected":""}>${t}</option>`).join("")+'<option value="__new__">+ Nuova tipologia…</option>'}</select></div>
        <div><label class="form-label">Formato <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— lascia vuoto per 750ml standard</span></label><select class="form-select" id="mf-formato" onchange="updateModalCalc()">${FORMATI_OPTS}</select></div>
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-label">🌍 Provenienza</div>
      <div class="form-grid g2">
        <div><label class="form-label">Regione</label><input class="form-input" id="mf-regione" value="${h(f.regione)}" placeholder="es. Piemonte"></div>
        <div><label class="form-label">Nazione</label><input class="form-input" id="mf-nazione" value="${h(f.nazione||"Italia")}" placeholder="es. Italia"></div>
        <div class="col-span-2"><label class="form-label">Zona / Cru</label><input class="form-input" id="mf-zona" value="${h(f.zona)}" placeholder="es. Cannubi, Vigna Rionda…"></div>
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-label">💰 Prezzi & Giacenza</div>
      <div class="form-grid g2">
        <div><label class="form-label">Prezzo Acquisto (escl. IVA) €</label><input class="form-input" id="mf-prezzoAcq" type="number" inputmode="decimal" onfocus="this.select()" value="${f.prezzoAcq}" placeholder="0.00" oninput="updateModalCalc()"></div>
        <div><label class="form-label">IVA %</label><select class="form-select" id="mf-iva" onchange="updateModalCalc()">${IVA_OPTIONS.map(v=>`<option value="${v}" ${parseInt(f.iva)===v?"selected":""}>${v}%</option>`).join("")}</select></div>
        <div><label class="form-label">Prezzo in Carta €</label><input class="form-input" id="mf-prezzoCarta" type="number" inputmode="decimal" onfocus="this.select()" value="${f.prezzoCarta}" placeholder="0.00" oninput="document.getElementById('mf-prezzoCarta')._userEdited=true;updateModalCalc()">
          <div id="mc-carta-hint" style="display:none;align-items:center;gap:8px;margin-top:5px;padding:5px 8px;background:rgba(255,159,10,.08);border:1px solid rgba(255,159,10,.12);font-size:10px;color:var(--txt3)">
            <span>Suggerito (<span id="mc-carta-molt-label"></span>):</span><span class="mc-carta-val" style="color:var(--amber);font-family:'Montserrat',sans-serif"></span>
            <button type="button" onclick="applyCartaSuggerita()" style="margin-left:auto;font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;border:1px solid rgba(180,83,9,.5);color:var(--amber);background:rgba(255,159,10,.12);cursor:pointer;font-family:inherit">Usa →</button>
          </div>
        </div>
        <div><label class="form-label">Prezzo al Calice € <span style="color:var(--txt4);font-size:9px;text-transform:none;letter-spacing:0">— opzionale</span></label><input class="form-input" id="mf-prezzoCalice" type="number" inputmode="decimal" onfocus="this.select()" value="${f.prezzoCalice||''}" placeholder="es. 8.00"></div>
        <div><label class="form-label">Giacenza (bottiglie)</label><input class="form-input" id="mf-giacenza" type="number" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" value="${f.giacenza||0}" placeholder="0" oninput="updateModalCalc()" ${wine&&(wine.lots||[]).some(l=>l.qtyRimanente>0)?'title="⚠️ Vino con lotti FIFO attivi: modifica tramite carico/scarico per non desincronizzare i lotti" style="border-color:rgba(180,83,9,.5)"':''} ><\/div>${wine&&(wine.lots||[]).some(l=>l.qtyRimanente>0)?'<div style="font-size:9px;color:rgba(251,146,60,.8);margin-top:3px;letter-spacing:.05em">⚠️ Lotti FIFO attivi — usa carico/scarico per aggiornare la giacenza<\/div>':''}
      </div>
      ${(()=>{const on=!!f.inFresco;return `<div style="margin-top:12px">
        <label class="form-label">Servizio in carta</label>
        <div id="mf-fresco-toggle" role="switch" tabindex="0" aria-checked="${on}" onclick="_toggleFresco()" onkeydown="if(event.key===' '||event.key==='Enter'){event.preventDefault();_toggleFresco()}"
          style="display:flex;align-items:center;gap:12px;cursor:pointer;padding:12px 16px;border:1.5px solid ${on?'#30D158':'#FF453A'};border-radius:10px;user-select:none;transition:all .2s;background:${on?'rgba(48,209,88,.10)':'rgba(255,69,58,.08)'}">
          <span id="mf-fresco-dot" style="width:16px;height:16px;border-radius:50%;flex-shrink:0;transition:all .2s;background:${on?'#30D158':'#FF453A'};box-shadow:0 0 8px ${on?'rgba(48,209,88,.7)':'rgba(255,69,58,.6)'}"></span>
          <span id="mf-fresco-txt" style="font-size:13px;font-weight:700;font-family:'Montserrat',sans-serif;letter-spacing:.02em;color:${on?'#30D158':'#FF6B6B'}">${on?'In fresco':'Non in fresco'}</span>
          <span id="mf-fresco-ico" style="margin-left:auto;font-size:18px">${on?'❄️':'🌡️'}</span>
        </div>
        <input type="checkbox" id="mf-infresco" ${on?'checked':''} style="display:none">
      </div>`})()}
      <div class="calc-panel">
        <div><div class="calc-label">Costo+IVA/bottiglia</div><div class="calc-val c-amber" id="mc-costoiva">—</div></div>
        <div><div class="calc-label">Margine Lordo/bottiglia</div><div class="calc-val" id="mc-margine">—</div></div>
        <div><div class="calc-label">Valore al Costo (stock)</div><div class="calc-val" style="color:rgba(245,158,11,.7)" id="mc-valore">—</div></div>
        <div><div class="calc-label">Margine % (su prezzo carta)</div><div class="calc-val" id="mc-margperc">—</div></div>
      </div>
    </div>
    ${lotsHtml}
    ${(()=>{
      if(!wine?.priceHistory?.length) return '';
      const hist=[...wine.priceHistory].reverse();
      const SOURCE_LABEL={'carico':'Carico','modifica_scheda':'Modifica scheda','carta_rapida':'P.Carta rapida','ricezione_ordine':'Ricezione ordine','ricezione_globale':'Ricezione globale','manuale':'Manuale'};
      return `<div style="margin-top:4px">
        <div class="modal-section-label">📈 Storico Prezzi</div>
        <div style="display:grid;grid-template-columns:90px 1fr 110px 110px 110px 110px;gap:0;font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--txt4);padding:6px 12px;background:rgba(41,37,36,.4)">
          <span>Data</span><span>Evento</span><span style="text-align:right">P.Acq nuovo</span><span style="text-align:right">P.Acq prec.</span><span style="text-align:right">P.Carta nuovo</span><span style="text-align:right">P.Carta prec.</span>
        </div>
        ${hist.map(e=>{
          const acqChanged=e.prezzoAcq!==e.prevAcq;
          const cartaChanged=e.prezzoCarta!==e.prevCarta;
          return `<div style="display:grid;grid-template-columns:90px 1fr 110px 110px 110px 110px;gap:0;padding:7px 12px;border-bottom:1px solid rgba(41,37,36,.5);font-size:11px;align-items:center">
            <span style="color:var(--txt3)">${e.data}</span>
            <span style="color:var(--txt2);font-size:10px;letter-spacing:.08em;text-transform:uppercase">${SOURCE_LABEL[e.source]||e.source}</span>
            <span style="text-align:right;${acqChanged?'color:var(--amber)':'color:var(--txt4)'}">${e.prezzoAcq?fmt(e.prezzoAcq):'—'}</span>
            <span style="text-align:right;color:var(--txt4);font-size:10px">${e.prevAcq?fmt(e.prevAcq):'—'}</span>
            <span style="text-align:right;${cartaChanged?'color:#30D158':'color:var(--txt4)'}">${e.prezzoCarta?fmt(e.prezzoCarta):'—'}</span>
            <span style="text-align:right;color:var(--txt4);font-size:10px">${e.prevCarta?fmt(e.prevCarta):'—'}</span>
          </div>`;
        }).join('')}
      </div>`;
    })()}
    `;
}
function updateModalCalc(){
  const pAcq=parseFloat(document.getElementById("mf-prezzoAcq")?.value)||0;
  const iva=parseInt(document.getElementById("mf-iva")?.value)||22;
  const cartaInput=document.getElementById("mf-prezzoCarta");
  const carta=parseFloat(cartaInput?.value)||0;
  const giac=parseInt(document.getElementById("mf-giacenza")?.value)||0;
  const costoIva=pAcq*(1+iva/100);
  // formula suggerita: fascia su prezzoAcq con IVA inclusa
  const _wTmp = {prezzoAcq: pAcq, iva, nome: document.getElementById("mf-nome")?.value||"", formato: document.getElementById("mf-formato")?.value||""};
  const molt = _getMolt(_wTmp);
  const cartaSuggerita = pAcq>0 ? Math.ceil(costoIva * molt) : null;
  const cartaSuggeritaLabel = pAcq>0 ? _getMoltLabel(_wTmp) : "";
  const marg=carta&&costoIva?carta-costoIva:null;
  const margP=carta&&costoIva?((carta-costoIva)/carta)*100:null;
  const val=pAcq*giac; // valore stimato al costo nel modal (lotti non ancora salvati)
  const el=id=>document.getElementById(id);
  if(el("mc-costoiva")) el("mc-costoiva").textContent=fmtRound(costoIva);
  if(el("mc-valore")) el("mc-valore").textContent=fmt(val);
  if(el("mc-margine")){el("mc-margine").textContent=marg===null?"—":fmt(marg);el("mc-margine").style.color=marg===null?"var(--txt4)":marg>=0?"#007AFF":"#FF453A";}
  if(el("mc-margperc")){el("mc-margperc").textContent=margP===null?"—":`${fmtN(margP,1)}%`;el("mc-margperc").style.color=margP===null?"var(--txt4)":margP>=0?"#30D158":"#FF453A";}
  // mostra/aggiorna hint prezzo carta suggerito + auto-applica se vuoto
  const hint=el("mc-carta-hint");
  if(hint){
    if(cartaSuggerita){
      hint.style.display="flex";
      hint.querySelector(".mc-carta-val").textContent=fmt(cartaSuggerita);
      const lbl=document.getElementById("mc-carta-molt-label");
      if(lbl) lbl.textContent=cartaSuggeritaLabel;
      // auto-applica solo se il campo è ancora vuoto e l'utente non l'ha modificato
      // S3: usa String() non fmtN() — fmtN produce "45,50" (locale it-IT) che parseFloat tronca a 45
      if(cartaInput&&carta===0&&!cartaInput._userEdited){
        cartaInput.value=String(cartaSuggerita);
        cartaInput.dispatchEvent(new Event('input',{bubbles:true}));
      }
    } else {
      hint.style.display="none";
    }
  }
  const nome=document.getElementById("mf-nome")?.value.trim()||"";
  const prod=document.getElementById("mf-produttore")?.value.trim()||"";
  document.getElementById("modal-save").disabled=!nome||!prod;
}
function applyCartaSuggerita(){
  const pAcq=parseFloat(document.getElementById("mf-prezzoAcq")?.value)||0;
  const iva=parseInt(document.getElementById("mf-iva")?.value)||22;
  const nome=document.getElementById("mf-nome")?.value||"";
  const formato=document.getElementById("mf-formato")?.value||"";
  // S3+S4: usa _calcPrezzoCartaSuggerito (Math.ceil, euro intero) — formula unica coerente
  // con _applyPrezzoCartaSuggerito globale; String() evita virgola locale di fmtN
  const suggerito=_calcPrezzoCartaSuggerito({prezzoAcq:pAcq,iva,nome,formato});
  const inp=document.getElementById("mf-prezzoCarta");
  if(inp&&suggerito){inp.value=String(suggerito);inp._userEdited=false;updateModalCalc();}
}
// ─── VITIGNI NORMALIZATION ───────────────────────────────────────────────────
// Split su tutti i separatori comuni, trim, collapse whitespace interno,
// dedup case-insensitive (preserva la prima grafia incontrata), re-join ", ".
// NON forza il casing (eviterebbe "Nero d'Avola" → "Nero D'avola").
function _normVitigni(str){
  if(!str) return "";
  const seen = new Map();
  String(str).split(/[,;/&+]+/).forEach(raw=>{
    const v = raw.trim().replace(/\s+/g,' ');
    if(!v) return;
    const k = v.toLowerCase();
    if(!seen.has(k)) seen.set(k, v);
  });
  return [...seen.values()].join(", ");
}

function _paintFresco(){
  const cb=document.getElementById("mf-infresco"); if(!cb) return;
  const on=cb.checked, box=document.getElementById("mf-fresco-toggle");
  box.setAttribute("aria-checked",on);
  box.style.borderColor=on?"#30D158":"#FF453A";
  box.style.background=on?"rgba(48,209,88,.10)":"rgba(255,69,58,.08)";
  const dot=document.getElementById("mf-fresco-dot");
  dot.style.background=on?"#30D158":"#FF453A";
  dot.style.boxShadow=on?"0 0 8px rgba(48,209,88,.7)":"0 0 8px rgba(255,69,58,.6)";
  const txt=document.getElementById("mf-fresco-txt");
  txt.textContent=on?"In fresco":"Non in fresco"; txt.style.color=on?"#30D158":"#FF6B6B";
  document.getElementById("mf-fresco-ico").textContent=on?"❄️":"🌡️";
}
function _toggleFresco(){
  const cb=document.getElementById("mf-infresco"); if(!cb) return;
  cb.checked=!cb.checked; _paintFresco();
}
function saveWine(){
  const get=id=>document.getElementById(id)?.value||"";
  let wine={
    id:modalWine?.id||uid(),
    nome:get("mf-nome").trim(),produttore:get("mf-produttore").trim(),distributore:get("mf-distributore"),
    annata:get("mf-annata"),vitigni:_normVitigni(get("mf-vitigni")),tipologia:get("mf-tipologia"),formato:parseFloat(get("mf-formato"))||0.75,
    regione:get("mf-regione"),nazione:get("mf-nazione"),zona:get("mf-zona"),
    prezzoAcq:parseFloat(get("mf-prezzoAcq"))||0,iva:parseInt(get("mf-iva"))||22,
    prezzoCarta:parseFloat(get("mf-prezzoCarta"))||0,
    prezzoCalice:parseFloat(get("mf-prezzoCalice"))||0,
    giacenza:parseInt(get("mf-giacenza"))||0,
    inFresco:document.getElementById("mf-infresco")?.checked||false,
    lots:modalWine?.lots||[]
  };
  if(!wine.nome||!wine.produttore){ notify("⚠️ Nome e Produttore sono obbligatori","err"); return; }
  // Auto-inferisce la nazione dalla regione se non compilata
  if(!wine.nazione && wine.regione){
    wine.nazione = inferPaese("", wine.regione, wine.zona);
  }
  // Se ancora mancante, usa default Italia
  if(!wine.nazione) wine.nazione = "Italia";
  if(modalWine){
    const prev=wines.find(w=>w.id===wine.id)||{};
    const wTracked=_trackPriceChange(prev, wine.prezzoAcq, wine.prezzoCarta, 'modifica_scheda');
    wine={...wine, priceHistory:wTracked.priceHistory};
    wines=wines.map(w=>w.id===wine.id?wine:w);notify("✅ Vino aggiornato");
  }
  else{wines=[...wines,wine];notify("✅ Vino aggiunto in cantina");}
  const _scrollY = window.scrollY;
  closeWineModal();
  scheduleSave();
  if(section==="inventario"){ renderInventarioOnly(); requestAnimationFrame(()=>window.scrollTo(0,_scrollY)); }
  else render();
}

// ─── BULK DELETE ──────────────────────────────────────────────────────────────
function bulkDeleteWines(){
  if(selIds.size===0) return;
  const n = selIds.size;
  const snap = new Set(selIds); // snapshot — selIds può cambiare durante callback
  _confirmModal(
    `Eliminare <strong>${n} vin${n===1?'o':'i'}</strong>?<br><span style="font-size:11px;color:var(--txt4)">Verranno rimossi anche movimenti e fallate collegati.</span>`,
    `🗑️ Elimina ${n} ${n===1?'vino':'vini'}`,
    () => {
      wines=wines.filter(w=>!snap.has(w.id));
      movements=movements.filter(m=>!snap.has(m.wineId));
      fallate=fallate.filter(f=>!snap.has(f.wineId));
      snap.forEach(id=>{ delete alertSoglie[id]; delete scaricoSerata.qtys[id]; });
      notify(`🗑️ ${n} vin${n===1?'o':'i'} eliminati`);
      exitSel(); scheduleSave();
      // PATCH: flush immediato — eliminazione irreversibile
      clearTimeout(saveTimer); _flushSave();
      render();
    },
    'danger'
  );
}
function bulkDeleteMovimenti(){
  if(selIds.size===0) return;
  const n=selIds.size;
  const snap = new Set(selIds);
  _confirmModal(
    `Eliminare <strong>${n} moviment${n===1?'o':'i'}</strong>?<br><span style="font-size:11px;color:var(--txt4)">Le giacenze verranno ricalcolate automaticamente dai movimenti rimanenti (FIFO).</span>`,
    `🗑️ Elimina e ricalcola`,
    () => {
      // FIX T-B8: usa snap direttamente — non riassegnare selIds (race con exitSel)
      movements=movements.filter(m=>!snap.has(m.id));
      // S2 FIX: FIFO full recalc senza mutazione diretta dell'array wines[].
      wines=wines.map(w=>({...w,giacenza:0,lots:[]}));
      const sorted=[...movements].sort((a,b)=>a.data.localeCompare(b.data)||a.ts-b.ts);
      sorted.forEach(m=>{
        const wIdx=wines.findIndex(w=>w.id===m.wineId);
        if(wIdx<0) return;
        const w=wines[wIdx];
        const q=parseInt(m.qty)||0;
        if(m.tipo==="carico"){
          const pAcq=parseFloat(m.prezzoAcqLotto)||parseFloat(w.prezzoAcq)||0;
          const newLot={id:m.id+"_lot",data:m.data,fattura:m.fattura||"",fornitore:m.fornitore||"",prezzoAcq:pAcq,iva:w.iva,qtyCaricata:q,qtyRimanente:q};
          wines[wIdx]={...w,giacenza:w.giacenza+q,lots:[...(w.lots||[]),newLot]};
        } else {
          let rem=q;
          const updLots=(w.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c}});
          wines[wIdx]={...w,giacenza:Math.max(0,w.giacenza-q),lots:updLots};
        }
      });
      notify(`🗑️ ${n} movimenti eliminati — giacenze ricalcolate`);
      exitSel(); scheduleSave();
      // PATCH: flush immediato — eliminazione + ricalcolo FIFO è irreversibile
      clearTimeout(saveTimer); _flushSave();
      render();
    },
    'danger'
  );
}
function bulkDeleteOrdini(){
  if(selIds.size===0) return;
  const n=selIds.size;
  const snap=new Set(selIds);
  _confirmModal(
    `Eliminare <strong>${n} ordin${n===1?'e':'i'}</strong>?`,
    `🗑️ Elimina ${n} ${n===1?'ordine':'ordini'}`,
    async ()=>{
      // Ordini locali
      orders=orders.filter(o=>!snap.has(o.id));
      // Bozze remote su ordini_testata
      const bozzeIds=[...snap].filter(id=>_bozzeSb.some(b=>b.id===id));
      if(bozzeIds.length && _sb){
        await _sb.from('ordini_testata').delete().in('id', bozzeIds);
        _bozzeSb=_bozzeSb.filter(b=>!snap.has(b.id));
      }
      notify(`🗑️ ${n} ordin${n===1?'e':'i'} eliminati`);
      exitSel(); scheduleSave();
      // PATCH: flush immediato — eliminazione irreversibile
      clearTimeout(saveTimer); _flushSave();
      render();
    },
    'danger'
  );
}

// ─── BULK EDIT MODAL ──────────────────────────────────────────────────────────
let _bulkMode=null;
const _bulkFields={
  wines:[
    {key:"produttore",label:"Produttore",type:"text"},
    {key:"distributore",label:"Distributore",type:"text"},
    {key:"nome",label:"Nome Vino",type:"text"},
    {key:"tipologia",label:"Tipologia",type:"select",opts:[...TIPOLOGIE,"__new__"],labels:{...Object.fromEntries(TIPOLOGIE.map(t=>[t,t])),__new__:"+ Nuova tipologia…"}},
    {key:"annata",label:"Annata",type:"text"},
    {key:"regione",label:"Regione",type:"text"},
    {key:"nazione",label:"Nazione",type:"text"},
    {key:"zona",label:"Zona/Cru",type:"text"},
    {key:"vitigni",label:"Vitigni",type:"text"},
    {key:"prezzoAcq",label:"Prezzo Acquisto (€)",type:"number"},
    {key:"prezzoCarta",label:"Prezzo Carta (€)",type:"number"},
    {key:"iva",label:"IVA %",type:"select",opts:["4","10","22"]},
    {key:"giacenza",label:"Giacenza",type:"number"},
  ],
  movimenti:[
    {key:"wineName",label:"Nome Vino",type:"text"},
    {key:"produttore",label:"Produttore",type:"text"},
    {key:"tipo",label:"Tipo",type:"select",opts:["carico","scarico"]},
    {key:"qty",label:"Quantità",type:"number"},
    {key:"data",label:"Data",type:"date"},
    {key:"fattura",label:"N° Fattura",type:"text"},
    {key:"fornitore",label:"Fornitore",type:"text"},
    {key:"note",label:"Note",type:"text"},
    {key:"annata",label:"Annata",type:"text"},
    {key:"vitigni",label:"Vitigni",type:"text"},
    {key:"regione",label:"Regione",type:"text"},
    {key:"nazione",label:"Nazione",type:"text"},
    {key:"zona",label:"Zona/Cru",type:"text"},
  ],
  ordini:[
    {key:"fornitore",label:"Fornitore",type:"text"},
    {key:"dataOrdine",label:"Data Ordine",type:"date"},
    {key:"note",label:"Note",type:"text"},
    {key:"stato",label:"Stato",type:"select",opts:["attesa","confermato_pendente","caricato"]},
  ],
};

function openBulkEditModal(mode){
  if(selIds.size===0){ notify("Seleziona almeno una riga","err"); return; }
  _bulkMode=mode;
  const fields=_bulkFields[mode]||[];
  const n=selIds.size;
  document.getElementById("bulk-modal-title").textContent=`✏️ Modifica in blocco — ${n} element${n===1?"o":"i"}`;
  const body=document.getElementById("bulk-modal-body");
  body.innerHTML=`
    <p style="font-size:11px;color:var(--txt3);margin-bottom:16px">Attiva i campi che vuoi modificare. I campi non attivati resteranno invariati.</p>
    ${fields.map(f=>`
    <div class="bulk-field-row" id="bfr-${f.key}">
      <label class="bulk-field-toggle">
        <input type="checkbox" id="bf-active-${f.key}" onchange="document.getElementById('bf-val-${f.key}').disabled=!this.checked">
        <span class="bulk-toggle-slider"></span>
      </label>
      <span class="bulk-field-label">${f.label}</span>
      <div class="bulk-field-input">
        ${f.type==="select"
          ? `<select id="bf-val-${f.key}" class="form-select" disabled>${f.opts.map(o=>`<option value="${o}">${o}</option>`).join("")}</select>`
          : `<input id="bf-val-${f.key}" type="${f.type==="number"?"number":f.type==="date"?"date":"text"}" class="form-input" disabled placeholder="${f.label}…"${f.type==="number"?' step="any"':''}>`
        }
      </div>
    </div>`).join("")}
  `;
  document.getElementById("bulk-modal-backdrop").classList.remove("hidden");
}

function closeBulkModal(e){
  if(e&&e.target!==document.getElementById("bulk-modal-backdrop")) return;
  document.getElementById("bulk-modal-backdrop").classList.add("hidden");
  _bulkMode=null;
}

function applyBulkEdit(){
  if(!_bulkMode) return;
  const fields=_bulkFields[_bulkMode]||[];
  const changes={};
  fields.forEach(f=>{
    const active=document.getElementById(`bf-active-${f.key}`)?.checked;
    if(!active) return;
    let val=document.getElementById(`bf-val-${f.key}`)?.value;
    if(f.type==="number") val=parseFloat(val)||0;
    changes[f.key]=val;
  });
  if(Object.keys(changes).length===0){ notify("Nessun campo selezionato","err"); return; }
  let count=0;
  if(_bulkMode==="wines"){
    wines=wines.map(w=>{
      if(!selIds.has(w.id)) return w;
      count++;
      return {...w,...changes};
    });
    notify(`✅ ${count} vini aggiornati`);
  } else if(_bulkMode==="movimenti"){
    // vitigni e annata appartengono al vino, non al movimento — aggiorna il wine corrispondente
    const wineChanges={};
    ["vitigni","annata","regione","nazione","zona"].forEach(k=>{
      if(changes[k]!==undefined){ wineChanges[k]=changes[k]; delete changes[k]; }
    });
    const affectedWineIds=new Set();
    // FIX T-B4: se tipo o qty cambiano in bulk, serve FIFO replay completo
    const needsFifoReplay = changes.tipo!==undefined || changes.qty!==undefined;
    const fifoWineIds=new Set();
    movements=movements.map(m=>{
      if(!selIds.has(m.id)) return m;
      count++;
      if(Object.keys(wineChanges).length) affectedWineIds.add(m.wineId);
      if(needsFifoReplay) fifoWineIds.add(m.wineId);
      return {...m,...changes};
    });
    if(affectedWineIds.size){
      wines=wines.map(w=>affectedWineIds.has(w.id)?{...w,...wineChanges}:w);
    }
    // FIX T-B4: replay FIFO completo per i vini i cui movimenti hanno cambiato tipo/qty
    if(needsFifoReplay && fifoWineIds.size){
      wines=wines.map(w=>fifoWineIds.has(w.id)?{...w,giacenza:0,lots:[]}:w);
      const sorted=[...movements].filter(m=>fifoWineIds.has(m.wineId))
        .sort((a,b)=>a.data.localeCompare(b.data)||(a.ts||0)-(b.ts||0));
      sorted.forEach(m=>{
        const wIdx=wines.findIndex(w=>w.id===m.wineId);
        if(wIdx<0) return;
        const w=wines[wIdx];
        const q=parseInt(m.qty)||0;
        if(q<=0) return;
        if(m.tipo==="carico"){
          const pAcq=parseFloat(m.prezzoAcqLotto)||parseFloat(w.prezzoAcq)||0;
          const lot={id:m.id+"_lot",data:m.data,fattura:m.fattura||"",fornitore:m.fornitore||"",prezzoAcq:pAcq,iva:w.iva||22,qtyCaricata:q,qtyRimanente:q};
          wines[wIdx]={...w,giacenza:w.giacenza+q,lots:[...(w.lots||[]),lot]};
        } else {
          let rem=q;
          const updLots=(w.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c};});
          wines[wIdx]={...w,giacenza:Math.max(0,w.giacenza-q),lots:updLots};
        }
      });
      // Applica anche le fallate dei vini coinvolti (FIFO consistency)
      fallate.filter(f=>fifoWineIds.has(f.wineId)).forEach(f=>{
        const wIdx=wines.findIndex(w=>w.id===f.wineId);
        if(wIdx<0) return;
        const w=wines[wIdx]; const q=parseInt(f.qty)||0;
        let rem=q;
        const updLots=(w.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c};});
        wines[wIdx]={...w,giacenza:Math.max(0,w.giacenza-q),lots:updLots};
      });
    }
    notify(`✅ ${count} movimenti aggiornati`);
  } else if(_bulkMode==="ordini"){
    orders=orders.map(o=>{
      if(!selIds.has(o.id)) return o;
      count++;
      return {...o,...changes};
    });
    notify(`✅ ${count} ordini aggiornati`);
  }
  scheduleSave();
  // PATCH: flush immediato se la bulk edit ha toccato giacenze
  clearTimeout(saveTimer); _flushSave();
  closeBulkModal();
  exitSel();
  render();
}

// ─── CONFIRM MODAL (sostituisce window.confirm per azioni distruttive) ─────────
// Uso: _confirmModal("Testo?", "Label bottone OK", callbackFn)
// Non blocca il thread, non viene soppresso in iframe/WebView, supporta Escape.
function _confirmModal(message, okLabel, onOk, dangerLevel='warn'){
  // rimuovi eventuali dialog precedenti
  const old = document.getElementById('cm-confirm-modal');
  if(old) old.remove();

  const colors = dangerLevel === 'danger'
    ? { bg:'rgba(255,69,58,.12)', border:'rgba(255,69,58,.35)', btnBg:'#FF453A', btnColor:'#fff' }
    : { bg:'rgba(255,159,10,.08)', border:'rgba(255,159,10,.3)', btnBg:'var(--amber)', btnColor:'#000' };

  const el = document.createElement('div');
  el.id = 'cm-confirm-modal';
  el.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px`;
  el.innerHTML = `
    <div style="background:var(--bg2);border:1px solid ${colors.border};border-radius:12px;max-width:400px;width:100%;padding:24px;font-family:'Montserrat',system-ui,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,.5)">
      <div style="font-size:13px;color:var(--txt);line-height:1.6;margin-bottom:20px">${message}</div>
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button id="cm-conf-cancel" style="padding:8px 18px;border:1px solid var(--border2);background:none;color:var(--txt2);cursor:pointer;font-family:inherit;font-size:12px;border-radius:8px">Annulla</button>
        <button id="cm-conf-ok" style="padding:8px 18px;background:${colors.btnBg};color:${colors.btnColor};border:none;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;border-radius:8px">${okLabel}</button>
      </div>
    </div>`;

  const close = () => el.remove();
  el.querySelector('#cm-conf-cancel').addEventListener('click', close);
  el.querySelector('#cm-conf-ok').addEventListener('click', () => { close(); onOk(); });
  el.addEventListener('click', e => { if(e.target === el) close(); });
  el.addEventListener('keydown', e => { if(e.key==='Escape') close(); if(e.key==='Enter'){close();onOk();} });

  document.body.appendChild(el);
  // Focus sul bottone OK per Enter immediato se intenzionale, Cancel con Tab
  setTimeout(()=>{ el.querySelector('#cm-conf-cancel').focus(); }, 40);
}

// ─── CONFIRM MODAL 2 — tre bottoni (azione-A / azione-B / annulla) ────────────
// Uso: _confirmModal2("Testo?", {label:"Btn A", cb:fnA}, {label:"Btn B", cb:fnB})
// Entrambe le azioni sono evidenziate; "Annulla" è il pulsante neutro.
function _confirmModal2(message, actionA, actionB){
  const old = document.getElementById('cm-confirm-modal2');
  if(old) old.remove();
  const el = document.createElement('div');
  el.id = 'cm-confirm-modal2';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  el.innerHTML = `
    <div style="background:var(--bg2);border:1px solid rgba(255,159,10,.3);border-radius:12px;max-width:420px;width:100%;padding:24px;font-family:'Montserrat',system-ui,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,.5)">
      <div style="font-size:13px;color:var(--txt);line-height:1.6;margin-bottom:20px">${message}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="cm2-a" style="width:100%;padding:10px 16px;background:rgba(255,69,58,.12);border:1px solid rgba(255,69,58,.35);color:#FF6B6B;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;text-align:left">${actionA.label}</button>
        <button id="cm2-b" style="width:100%;padding:10px 16px;background:rgba(255,159,10,.1);border:1px solid rgba(255,159,10,.3);color:var(--amber);cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;text-align:left">${actionB.label}</button>
        <button id="cm2-cancel" style="width:100%;padding:8px 16px;border:1px solid var(--border2);background:none;color:var(--txt3);cursor:pointer;font-family:inherit;font-size:12px;border-radius:8px">Annulla</button>
      </div>
    </div>`;
  const close = () => el.remove();
  el.querySelector('#cm2-a').addEventListener('click', ()=>{ close(); actionA.cb(); });
  el.querySelector('#cm2-b').addEventListener('click', ()=>{ close(); actionB.cb(); });
  el.querySelector('#cm2-cancel').addEventListener('click', close);
  el.addEventListener('click', e=>{ if(e.target===el) close(); });
  el.addEventListener('keydown', e=>{ if(e.key==='Escape') close(); });
  document.body.appendChild(el);
  setTimeout(()=>{ el.querySelector('#cm2-cancel').focus(); }, 40);
}


function deleteWine(id){
  const w = wines.find(x=>x.id===id);
  if(!w) return;
  _confirmModal(
    `Eliminare <strong>${w.nome}</strong>${w.produttore?' ('+w.produttore+')':''}?<br><span style="font-size:11px;color:var(--txt4)">Verranno rimossi anche movimenti e fallate collegati.</span>`,
    "🗑️ Elimina",
    () => {
      wines=wines.filter(x=>x.id!==id);
      movements=movements.filter(m=>m.wineId!==id);
      fallate=fallate.filter(f=>f.wineId!==id);
      delete alertSoglie[id];
      delete scaricoSerata.qtys[id];
      _selectedWineId=null;
      _updateTopbarActions(null);
      // PATCH: flush immediato — eliminazione irreversibile
      clearTimeout(saveTimer); _flushSave();
      notify("🗑️ Vino eliminato"); render();
    },
    'danger'
  );
}

// ─── CSV EXPORTS ──────────────────────────────────────────────────────────────
function dlCSV(content,filename){
  const blob=new Blob(["\uFEFF"+content],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  Object.assign(document.createElement("a"),{href:url,download:filename}).click();
  URL.revokeObjectURL(url);
}
function toCSV(rows){return rows.map(r=>r.map(v=>esc(v)).join(";")).join("\n")}

function exportInventarioCSV(){
  const dateStr=new Date().toLocaleDateString("it-IT");
  const headers=["Distributore","Produttore","Nome Vino","Vitigni","Annata","Zona/Cru","Regione","Tipologia","P.Acq (escl.IVA)","IVA %","Costo+IVA/bt","P.Carta","Marg.Lordo/bt","Marg.%","Giacenza","Val.Costo","IVA su Stock","Val.Potenziale Carta","IVA Pot.Vendita","Nota Veloce"];
  const rows=wines.map(w=>{const mb=calcMargineBottiglia(w);const mp=calcMarginePerc(w);const vc=calcValore(w);return [w.distributore||"",w.produttore,w.nome,w.vitigni||"",w.annata||"",w.zona||"",w.regione||"",w.tipologia,fmtN(w.prezzoAcq),w.iva+"%",fmtN(calcCostoIvaBottiglia(w)),fmtN(w.prezzoCarta),mb!==null?fmtN(mb):"—",mp!==null?fmtN(mp,1)+"%":"—",w.giacenza,fmtN(vc),fmtN(vc*(parseInt(w.iva)||22)/100),fmtN(calcValoreCarta(w)),fmtN(calcValoreCarta(w)*(parseInt(w.iva)||22)/100),w.noteVeloce||""];});
  dlCSV(toCSV([headers,...rows]),`giacenze_al_${dateStr.replace(/\//g,"-")}.csv`);
  notify("📥 Giacenze esportate");
}
function exportAcquistiCSV(){
  const dateStr=new Date().toLocaleDateString("it-IT");
  const wineMap=Object.fromEntries(wines.map(w=>[w.id,w]));
  const carichi=[...movements].filter(m=>m.tipo==="carico").sort((a,b)=>a.data.localeCompare(b.data));
  const headers=["Data","N° Fattura","Fornitore/Distributore","Produttore","Nome Vino","Annata","Tipologia","Qtà","P.Acquisto/bt","IVA %","Imponibile","IVA Assolta","Totale Riga","Note"];
  let totQty=0,totImp=0,totIva=0;
  const rows=carichi.map(m=>{const w=wineMap[m.wineId];const p=parseFloat(m.prezzoAcqLotto)||parseFloat(w?.prezzoAcq)||0;const iva=parseInt(w?.iva)||22;const imp=p*m.qty;const iv=imp*(iva/100);totQty+=m.qty;totImp+=imp;totIva+=iv;return [m.data,m.fattura||"—",m.fornitore||w?.distributore||"—",m.produttore||w?.produttore||"",m.wineName,w?.annata||"",w?.tipologia||"",m.qty,fmtN(p),iva+"%",fmtN(imp),fmtN(iv),fmtN(imp+iv),m.note||""];});
  dlCSV(toCSV([headers,...rows,[],["","","","","","","TOTALE",totQty,"","",fmtN(totImp),fmtN(totIva),fmtN(totImp+totIva),""]]),`registro_acquisti_${dateStr.replace(/\//g,"-")}.csv`);
  notify("📥 Acquisti esportati");
}
function exportFallateCSV(){
  const dateStr=new Date().toLocaleDateString("it-IT");
  const wineMap=Object.fromEntries(wines.map(w=>[w.id,w]));
  const sorted=[...fallate].sort((a,b)=>a.data.localeCompare(b.data));
  const headers=["Data","Nome Vino","Produttore","Nazione","Tipologia","Annata","Qtà","Costo/bt","IVA %","Val.Costo Perdita","IVA su Perdita","Val.Totale Perdita","Motivazione","Note"];
  let tQ=0,tC=0,tI=0;
  const rows=sorted.map(f=>{const w=wineMap[f.wineId];const p=parseFloat(w?.prezzoAcq)||0;const iva=parseInt(w?.iva)||22;const vc=p*f.qty;const iv=vc*(iva/100);tQ+=f.qty;tC+=vc;tI+=iv;return [f.data,f.wineName,f.produttore||"",w?.nazione||"",w?.tipologia||"",w?.annata||"",f.qty,fmtN(p),iva+"%",fmtN(vc),fmtN(iv),fmtN(vc+iv),f.motivo,f.note||""];});
  // M6: allinea riga totali alle 14 colonne dell'header (Data,Nome,Prod,Naz,Tipo,Annata,Qtà,Costo/bt,IVA%,ValCosto,IVAPerdita,Totale,Motivo,Note)
  dlCSV(toCSV([headers,...rows,[],["","","","","","",tQ,"","",fmtN(tC),fmtN(tI),fmtN(tC+tI),"",""]]),`registro_fallate_${dateStr.replace(/\//g,"-")}.csv`);
  notify("📥 Fallate esportate");
}
function exportMovimentiCSV(){
  const dateStr=new Date().toLocaleDateString("it-IT");
  const wineMap=Object.fromEntries(wines.map(w=>[w.id,w]));
  const sorted=[...movements].sort((a,b)=>a.data.localeCompare(b.data));
  const headers=["Data","Tipo","N° Fattura","Fornitore","Nome Vino","Produttore","Nazione","Annata","Qtà","P.Acq/bt","IVA%","Valore Mov.","Note"];
  const rows=sorted.map(m=>{const w=wineMap[m.wineId];
    // M7: per scarichi usa costoUnitarioIva snapshot; per carichi usa prezzoAcqLotto del lotto
    const p=m.tipo==="scarico"
      ? (m.costoUnitarioIva || parseFloat(w?.prezzoAcq)||0)
      : (parseFloat(m.prezzoAcqLotto)||parseFloat(w?.prezzoAcq)||0);
    return [m.data,m.tipo.toUpperCase(),m.fattura||"",m.fornitore||"",m.wineName,m.produttore||"",m.nazione||w?.nazione||"",w?.annata||"",(m.tipo==="carico"?"+":"-")+m.qty,fmtN(p),(parseInt(w?.iva)||22)+"%",fmtN(p*m.qty),m.note||""];});
  dlCSV(toCSV([headers,...rows]),`movimenti_${dateStr.replace(/\//g,"-")}.csv`);
  notify("📥 Movimenti esportati");
}
// ─── MODALITÀ MOBILE ─────────────────────────────────────────────────────────

// ── CSS injection per classi mobile ──────────────────────────────────────────
// Le classi mob-step-btn, mob-confirm-btn, mob-acc-* non sono in index.html CSS
// (refactoring incrementale). Le iniettiamo qui una volta sola al caricamento JS.
(function _injectMobCSS(){
  if(document.getElementById('cm-mob-css')) return; // già iniettato
  const style = document.createElement('style');
  style.id = 'cm-mob-css';
  style.textContent = `
/* ── Accordion tipologia ── */
.mob-acc-group { border-bottom: 1px solid var(--border); }
.mob-acc-header {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; background: var(--bg2); border: none; cursor: pointer;
  font-family: 'Montserrat', system-ui, sans-serif; gap: 8px;
  -webkit-tap-highlight-color: transparent;
}
.mob-acc-header:active { background: rgba(255,255,255,.06); }
.mob-acc-title {
  font-size: 10px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase;
  color: var(--amber); flex: 1; text-align: left;
}
.mob-acc-meta { font-size: 10px; color: var(--txt4); flex-shrink: 0; }
.mob-acc-arrow { font-size: 10px; color: var(--txt4); flex-shrink: 0; }
.mob-acc-body { background: var(--bg); }

/* ── Riga vino ── */
.mob-wine-sub {
  font-size: 10px; color: var(--txt4); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── Stepper quantità ── */
.mob-stepper {
  display: flex; align-items: center; gap: 0;
  border: 1px solid var(--border2); border-radius: 8px; overflow: hidden;
}
.mob-step-btn {
  min-width: 44px; min-height: 44px; width: 44px; height: 44px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; font-weight: 300; background: var(--bg3); border: none;
  color: var(--txt2); cursor: pointer; font-family: inherit;
  -webkit-tap-highlight-color: transparent; user-select: none;
  transition: background .1s;
}
.mob-step-btn:active { background: rgba(255,159,10,.2); color: var(--amber); }
.mob-step-val {
  min-width: 32px; text-align: center; font-family: 'Montserrat', sans-serif;
  font-size: 1rem; font-weight: 500; color: var(--txt); padding: 0 4px;
  background: var(--bg3);
}

/* ── Bottone Scarica ── */
.mob-confirm-btn {
  min-height: 44px; padding: 0 16px; font-size: 12px; font-weight: 700;
  letter-spacing: .04em; text-transform: uppercase; font-family: inherit;
  background: rgba(255,69,58,.15); border: 1px solid rgba(255,69,58,.35);
  color: #FF6B6B; cursor: pointer; border-radius: 8px;
  -webkit-tap-highlight-color: transparent; transition: background .1s;
  white-space: nowrap;
}
.mob-confirm-btn:active:not(:disabled) { background: rgba(255,69,58,.35); color: #fff; }
.mob-confirm-btn.disabled,
.mob-confirm-btn:disabled {
  opacity: .3; cursor: not-allowed; background: var(--bg3);
  border-color: var(--border2); color: var(--txt4);
}

/* ── Scrollbar sottile inv-scroll-body (Webkit / macOS overlay) ── */
#inv-scroll-body::-webkit-scrollbar { width: 5px; }
#inv-scroll-body::-webkit-scrollbar-track { background: transparent; }
#inv-scroll-body::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
#inv-scroll-body::-webkit-scrollbar-thumb:hover { background: var(--txt4); }

/* ── Tab Bar Scarico / Storico ── */
#mob-tab-bar {
  display: flex; border-bottom: 1px solid var(--border);
  background: var(--bg2); flex-shrink: 0;
}
.mob-tab-btn {
  flex: 1; padding: 12px 0; font-size: 12px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; border: none;
  background: none; color: var(--txt3); cursor: pointer;
  font-family: 'Montserrat', system-ui, sans-serif;
  border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
  -webkit-tap-highlight-color: transparent;
}
.mob-tab-btn.active { color: var(--amber); border-bottom-color: var(--amber); }
#mob-scarico-pane, #mob-storico-pane { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
#mob-storico-pane { display: none; }

/* ── Storico rows ── */
#mob-storico-list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.mob-stor-row {
  display: flex; align-items: center; gap: 10px;
  padding: 13px 14px; border-bottom: 1px solid var(--border);
  transition: background .1s;
}
.mob-stor-row.annullato { opacity: .38; }
.mob-stor-row:active:not(.annullato) { background: rgba(255,255,255,.04); }
.mob-stor-info { flex: 1; min-width: 0; }
.mob-stor-name {
  font-size: 13px; font-weight: 600; color: var(--txt);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mob-stor-meta { font-size: 10px; color: var(--txt4); margin-top: 2px; }
.mob-stor-qty {
  font-size: 18px; font-weight: 700; font-family: 'Montserrat', sans-serif;
  color: var(--txt2); min-width: 28px; text-align: center; flex-shrink: 0;
}
.mob-stor-actions { display: flex; gap: 6px; flex-shrink: 0; }
.mob-stor-btn {
  min-height: 36px; min-width: 36px; padding: 0 10px;
  font-size: 11px; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; font-family: inherit; border-radius: 8px;
  border: 1px solid; cursor: pointer; background: none;
  -webkit-tap-highlight-color: transparent; transition: background .1s, opacity .1s;
  display: flex; align-items: center; justify-content: center;
}
.mob-stor-btn-edit {
  color: var(--amber); border-color: rgba(255,159,10,.35);
  background: rgba(255,159,10,.08);
}
.mob-stor-btn-edit:active { background: rgba(255,159,10,.25); }
.mob-stor-btn-del {
  color: #FF6B6B; border-color: rgba(255,69,58,.3);
  background: rgba(255,69,58,.08);
}
.mob-stor-btn-del:active { background: rgba(255,69,58,.28); }
.mob-stor-btn:disabled { opacity: .3; cursor: not-allowed; }
.mob-stor-annullato-badge {
  font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: var(--txt4); border: 1px solid var(--border2); border-radius: 4px; padding: 2px 6px;
}
.mob-stor-empty {
  padding: 48px 24px; text-align: center; color: var(--txt4);
  font-size: 12px; line-height: 2;
}

/* ── Bottom sheet modifica qty ── */
#mob-edit-sheet {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
  background: var(--bg2); border-radius: 20px 20px 0 0;
  box-shadow: 0 -8px 40px rgba(0,0,0,.45);
  padding: 0 0 env(safe-area-inset-bottom,16px);
  transform: translateY(100%); transition: transform .28s cubic-bezier(.32,.72,0,1);
  pointer-events: none;
}
#mob-edit-sheet.open { transform: translateY(0); pointer-events: all; }
.mob-sheet-handle {
  width: 36px; height: 4px; background: var(--border2); border-radius: 2px;
  margin: 10px auto 0;
}
.mob-sheet-title {
  font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
  color: var(--txt3); text-align: center; padding: 14px 20px 0;
}
.mob-sheet-wine {
  font-size: 15px; font-weight: 600; color: var(--txt); text-align: center;
  padding: 6px 20px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mob-sheet-stepper {
  display: flex; align-items: center; justify-content: center; gap: 0;
  margin: 20px auto; width: 180px;
  border: 1px solid var(--border2); border-radius: 12px; overflow: hidden;
}
.mob-sheet-step-btn {
  width: 56px; height: 56px; font-size: 26px; font-weight: 300;
  background: var(--bg3); border: none; color: var(--txt2); cursor: pointer;
  font-family: inherit; -webkit-tap-highlight-color: transparent;
  display: flex; align-items: center; justify-content: center;
  transition: background .1s;
}
.mob-sheet-step-btn:active { background: rgba(255,159,10,.2); color: var(--amber); }
#mob-sheet-val {
  flex: 1; text-align: center; font-size: 22px; font-weight: 700;
  font-family: 'Montserrat', sans-serif; color: var(--txt);
  background: var(--bg3);
}
.mob-sheet-actions {
  display: flex; gap: 10px; padding: 0 16px 16px;
}
.mob-sheet-cancel {
  flex: 1; height: 50px; border-radius: 12px; border: 1px solid var(--border2);
  background: var(--bg3); color: var(--txt3); font-size: 14px; font-weight: 600;
  font-family: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
}
.mob-sheet-confirm {
  flex: 2; height: 50px; border-radius: 12px; border: none;
  background: var(--amber); color: #000; font-size: 14px; font-weight: 700;
  font-family: inherit; cursor: pointer; letter-spacing: .02em;
  -webkit-tap-highlight-color: transparent;
}
#mob-sheet-overlay {
  position: fixed; inset: 0; z-index: 9998; background: rgba(0,0,0,.4);
  display: none; backdrop-filter: blur(2px);
}
#mob-sheet-overlay.open { display: block; }

/* ── Storico header totale serata ── */
.mob-stor-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; background: var(--bg2); border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.mob-stor-header-label { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--txt4); }
.mob-stor-header-val { font-size: 13px; font-weight: 700; color: var(--txt); font-family: 'Montserrat', sans-serif; }
  `;
  document.head.appendChild(style);
})();

function _isMobile(){
  // Considera mobile se larghezza < 768px OPPURE se è un dispositivo touch con schermo piccolo
  const w = window.innerWidth || document.documentElement.clientWidth;
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  return w < 768 || (isTouch && w < 1024);
}

function enterMobileMode(){
  _mobActive = true;
  document.getElementById("mob-screen").style.display = "flex";
  document.getElementById("app").style.display = "none";

  // Inietta tab bar + storico pane se non già presenti
  if(!document.getElementById("mob-tab-bar")){
    _injectMobStoricoDom();
  }

  _renderMobLog();
  _renderMobStorico();
  // Carica subito il backup locale (se esiste) così la lista appare immediatamente.
  _loadLocalBackup();
  if(wines.length > 0){
    _renderMobList();
  } else {
    // Nessun dato locale: mostra messaggio di attesa esplicito
    const list = document.getElementById("mob-list");
    if(list) list.innerHTML = `<div style="text-align:center;padding:48px 24px;color:var(--txt4);font-size:12px;line-height:2">⏳ Connessione a Supabase…<br><span style="font-size:10px;color:var(--txt4);opacity:.6">Attendere qualche secondo</span></div>`;
  }
}

function exitMobileMode(){
  _mobActive = false;
  document.getElementById("mob-screen").style.display = "none";
  const app = document.getElementById("app");
  app.classList.remove("hidden");
  app.style.display = "flex";
  _hideMobToast();
}

function mobFilter(q){
  _mobQuery = q.toLowerCase().trim();
  _renderMobList();
}

function _renderMobList(){
  const q = _mobQuery;
  const filtered = wines.filter(w => {
    const giac = parseInt(w.giacenza)||0;
    if(giac <= 0) return false;
    if(!q) return true;
    const hay = (w.nome+" "+w.produttore+" "+(w.annata||"")+" "+(w.denominazione||"")+" "+w.tipologia).toLowerCase();
    return hay.includes(q);
  });

  const list = document.getElementById("mob-list");
  const empty = document.getElementById("mob-empty");
  if(!list) return;

  if(filtered.length === 0){
    list.innerHTML = "";
    empty.style.display = "block";
    empty.textContent = q ? "Nessun vino trovato" : "Nessun vino disponibile in cantina";
    return;
  }
  empty.style.display = "none";

  // Raggruppa per tipologia seguendo ordine TIPOLOGIE
  const groups = {};
  TIPOLOGIE.forEach(t => { groups[t] = []; });
  filtered.forEach(w => {
    const t = w.tipologia || "Altro";
    if(!groups[t]) groups[t] = [];
    groups[t].push(w);
  });

  // Inizializza accordion: aperto di default se non ancora impostato
  TIPOLOGIE.forEach(t => {
    if(_mobAccordionOpen[t] === undefined) _mobAccordionOpen[t] = true;
  });

  let html = "";
  TIPOLOGIE.forEach(t => {
    const grp = groups[t];
    if(!grp || grp.length === 0) return;
    grp.sort((a,b) => a.nome.localeCompare(b.nome));

    const isOpen = _mobAccordionOpen[t] !== false;
    html += `<div class="mob-acc-group">
      <button class="mob-acc-header" onclick="mobToggleAccordion(${JSON.stringify(t)})">
        <span class="mob-acc-title">${h(t.toUpperCase())}</span>
        <span class="mob-acc-meta">${grp.length} ${grp.length===1?"referenza":"referenze"} &nbsp; ${grp.reduce((s,w)=>s+(parseInt(w.giacenza)||0),0)} bt</span>
        <span class="mob-acc-arrow">${isOpen?"▲":"▼"}</span>
      </button>`;

    if(isOpen){
      html += `<div class="mob-acc-body">`;
      grp.forEach(w => {
        const giac = parseInt(w.giacenza)||0;
        const sg = _getSoglie(w.id);
        const gClass = giac <= 0 ? "zero" : giac <= sg.min ? "low" : "";
        const qty = _mobSteppers[w.id] || 1;
        const canScarica = giac >= qty;
        html += `<div class="mob-wine-row" data-mob-id="${w.id}">
          <div class="mob-wine-info">
            <div class="mob-wine-name">${h(w.nome)}${w.annata ? `<span class="mob-wine-annata"> ${h(w.annata)}</span>` : ""}</div>
            ${w.produttore || w.denominazione ? `<div class="mob-wine-sub">${[w.produttore,w.denominazione].filter(Boolean).map(s=>h(s)).join(" — ")}</div>` : ""}
          </div>
          <div class="mob-wine-right">
            <span class="mob-giacenza ${gClass}" id="mob-giac-${w.id}">${giac}</span>
            <div class="mob-stepper">
              <button class="mob-step-btn" onclick="mobStepChange('${w.id}',-1)" aria-label="Diminuisci">−</button>
              <span class="mob-step-val" id="mob-step-${w.id}">${qty}</span>
              <button class="mob-step-btn" onclick="mobStepChange('${w.id}',1)" aria-label="Aumenta">+</button>
            </div>
            <button class="mob-confirm-btn${canScarica?"":" disabled"}" onclick="mobScaricaConfirm('${w.id}')" ${canScarica?"":"disabled"}>Scarica</button>
          </div>
        </div>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
  });

  list.innerHTML = html;
}

function mobToggleAccordion(tipo){
  _mobAccordionOpen[tipo] = !(_mobAccordionOpen[tipo] !== false);
  _renderMobList();
}

function mobStepChange(wineId, delta){
  const cur = _mobSteppers[wineId] || 1;
  const wine = wines.find(w => w.id === wineId);
  const maxGiac = wine ? (parseInt(wine.giacenza)||0) : 999;
  const next = Math.max(1, Math.min(cur + delta, maxGiac));
  _mobSteppers[wineId] = next;
  const el = document.getElementById("mob-step-"+wineId);
  if(el) el.textContent = next;
  const rowEl = el && el.closest(".mob-wine-row");
  const btn = rowEl && rowEl.querySelector(".mob-confirm-btn");
  if(btn){
    const canScarica = maxGiac >= next;
    btn.disabled = !canScarica;
    btn.classList.toggle("disabled", !canScarica);
  }
}

function mobScaricaConfirm(wineId){
  const qty = _mobSteppers[wineId] || 1;
  _mobSteppers[wineId] = 1;
  registraMovimentoMobileQty(wineId, -qty);
}

// Versione ottimistica non-await: aggiorna UI subito, sync in background
function registraMovimentoMobileQty(wineId, delta){
  _hideMobToast();
  const wine = wines.find(w => w.id === wineId);
  if(!wine) return;
  const qty = Math.abs(delta);
  if(delta < 0 && wine.giacenza < qty) return;

  const prevGiacenza = wine.giacenza;
  const prevLots = JSON.parse(JSON.stringify(wine.lots||[]));
  const tipo = delta > 0 ? "carico" : "scarico";
  const dateStr = today();
  const fattura = `MOB-${dateStr}`;
  const movId = uid();

  // 1. Aggiornamento immediato in memoria
  wines = wines.map(w => {
    if(w.id !== wineId) return w;
    if(delta > 0){
      const pAcq = parseFloat(w.prezzoAcq)||0;
      const newLot = {id:uid(), data:dateStr, fattura, fornitore:"", prezzoAcq:pAcq, iva:w.iva, qtyCaricata:qty, qtyRimanente:qty};
      return {...w, giacenza:w.giacenza+qty, lots:[...(w.lots||[]),newLot]};
    } else {
      let rem = qty;
      const updLots = (w.lots||[]).map(l => {
        if(rem<=0||l.qtyRimanente<=0) return l;
        const c = Math.min(rem,l.qtyRimanente); rem-=c;
        return {...l, qtyRimanente:l.qtyRimanente-c};
      });
      return {...w, giacenza:w.giacenza-qty, lots:updLots};
    }
  });
  const newMov = {id:movId, wineId, wineName:wine.nome, produttore:wine.produttore,
    tipo, qty, data:dateStr, fattura, fornitore:"", note:"[mobile]", ts:Date.now()};
  movements = [newMov, ...movements];

  // 2. Aggiornamento ottimistico UI (solo il valore giacenza, senza re-render completo)
  const giacEl = document.getElementById("mob-giac-"+wineId);
  const newGiac = parseInt(wines.find(w=>w.id===wineId)?.giacenza)||0;
  if(giacEl){
    giacEl.textContent = newGiac;
    const sg = _getSoglie(wineId);
    giacEl.className = "mob-giacenza" + (newGiac<=0?" zero":newGiac<=sg.min?" low":"");
  }
  // Aggiorna stepper max e bottone
  const stepEl = document.getElementById("mob-step-"+wineId);
  const rowEl = stepEl && stepEl.closest(".mob-wine-row");
  if(rowEl){
    const confirmBtn = rowEl.querySelector(".mob-confirm-btn");
    const curStep = _mobSteppers[wineId]||1;
    if(confirmBtn){
      const canNow = newGiac >= curStep;
      confirmBtn.disabled = !canNow;
      confirmBtn.classList.toggle("disabled",!canNow);
    }
    if(newGiac <= 0){
      // Rimuovi la riga se giacenza esaurita
      setTimeout(()=>{ if(rowEl.parentNode) rowEl.remove(); }, 300);
    }
  }

  // 3. Persist in background (non blocca la UI)
  _saveLocalBackup();
  scheduleSave();

  // 4. Log & toast
  const ts = new Date().toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
  const desc = `Scaricato ${qty}× ${wine.nome}${wine.annata?" "+wine.annata:""}`;
  _mobLog = [{ts, desc, movId, wineId, qty, annullato:false, prevGiacenza, prevLots}, ..._mobLog];
  _renderMobLog();
  _mobUndoData = {wineId, delta, movId, prevGiacenza, prevLots};
  _showMobToast(desc);
  _renderMobStorico();
  updateSidebar();
}

function _renderMobLog(){
  const el = document.getElementById("mob-log");
  if(!el) return;
  const visible = _mobLog.filter(e => !e.annullato).slice(0,4);
  if(visible.length === 0){ el.innerHTML = `<div class="mob-log-item" style="color:var(--txt4)">Nessuna azione ancora</div>`; return; }
  el.innerHTML = visible.map(entry =>
    `<div class="mob-log-item"><span>${entry.ts}</span> — ${h(entry.desc)}</div>`
  ).join("");
}

async function registraMovimentoMobile(wineId, delta){
  _hideMobToast();

  const wine = wines.find(w => w.id === wineId);
  if(!wine){ return; }
  if(delta < 0 && wine.giacenza < 1){ return; }

  // Save undo snapshot
  const prevGiacenza = wine.giacenza;
  const prevLots = JSON.parse(JSON.stringify(wine.lots||[]));

  const tipo = delta > 0 ? "carico" : "scarico";
  const qty = Math.abs(delta);
  const dateStr = today();
  const fattura = `MOB-${dateStr}`;

  // Update wine in memory
  wines = wines.map(w => {
    if(w.id !== wineId) return w;
    if(delta > 0){
      const pAcq = parseFloat(w.prezzoAcq)||0;
      const newLot = {id:uid(), data:dateStr, fattura, fornitore:"", prezzoAcq:pAcq, iva:w.iva, qtyCaricata:qty, qtyRimanente:qty};
      return {...w, giacenza:w.giacenza+qty, lots:[...(w.lots||[]),newLot]};
    } else {
      let rem = qty;
      const updLots = (w.lots||[]).map(l => {
        if(rem<=0||l.qtyRimanente<=0) return l;
        const c = Math.min(rem,l.qtyRimanente); rem-=c;
        return {...l, qtyRimanente:l.qtyRimanente-c};
      });
      return {...w, giacenza:w.giacenza-qty, lots:updLots};
    }
  });

  const movId = uid();
  const newMov = {id:movId, wineId, wineName:wine.nome, produttore:wine.produttore,
    tipo, qty, data:dateStr, fattura, fornitore:"", note:"[mobile]", ts:Date.now()};
  movements = [newMov, ...movements];

  // Read-before-write: rileggi i VINI freschi prima di scrivere (protezione multi-utente).
  // I movimenti vanno invece sul ledger append-only: niente merge di blob, niente rischio
  // di azzerare la storia. newMov è già in `movements`, _flushMovementsV2 lo sincronizza.
  if(_sb){
    _setDbStatus("sync","Sincronizzazione…");
    try{
      const freshWines = await _sbRead("cm_wines");
      const freshW = freshWines ?? wines;
      const freshWineExists = freshW.some(w => w.id === wineId);
      const baseWines = freshWineExists ? freshW : wines;
      const mergedWines = baseWines.map(w => {
        if(w.id !== wineId) return w;
        if(delta > 0){
          const pAcq = parseFloat(w.prezzoAcq)||0;
          const newLot = {id:uid(), data:dateStr, fattura, fornitore:"", prezzoAcq:pAcq, iva:w.iva, qtyCaricata:qty, qtyRimanente:qty};
          return {...w, giacenza:(parseInt(w.giacenza)||0)+qty, lots:[...(w.lots||[]),newLot]};
        } else {
          let rem = qty;
          const updLots = (w.lots||[]).map(l => {
            if(rem<=0||l.qtyRimanente<=0) return l;
            const consumed = Math.min(rem,l.qtyRimanente); rem-=consumed;
            return {...l, qtyRimanente:l.qtyRimanente-consumed};
          });
          return {...w, giacenza:Math.max(0,(parseInt(w.giacenza)||0)-qty), lots:updLots};
        }
      });
      wines = mergedWines;
      // Prima la giacenza (blob), poi il movimento sul ledger: se il blob fallisce
      // non resta un movimento orfano che farebbe "resuscitare" lo scarico.
      await _sbUpsert("cm_wines", {user_id:DB_USER, data:wines});
      await _flushMovementsV2(); // movimento (delta-only) solo dopo giacenza committata
      _setDbStatus("ok","Sincronizzato");
    }catch(e){
      _setDbStatus("err","Errore sync");
    }
  }
  _saveLocalBackup();

  // Log entry
  const ts = new Date().toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
  const desc = delta < 0
    ? `Scaricato 1× ${wine.nome}${wine.annata?" "+wine.annata:""}`
    : `Caricato 1× ${wine.nome}${wine.annata?" "+wine.annata:""}`;
  _mobLog = [{ts, desc, movId, wineId, qty:Math.abs(delta), annullato:false, prevGiacenza, prevLots}, ..._mobLog];
  _renderMobLog();

  // Store undo data
  _mobUndoData = {wineId, delta, movId, prevGiacenza, prevLots};

  // Show toast
  _showMobToast(desc);

  // Re-render list
  _renderMobList();
  _renderMobStorico();
  updateSidebar();
}

function _showMobToast(msg){
  const toast = document.getElementById("mob-toast");
  const msgEl = document.getElementById("mob-toast-msg");
  const bar = document.getElementById("mob-toast-bar");
  if(!toast||!msgEl||!bar) return;

  msgEl.textContent = (msg.startsWith("Scaricato") ? "⬇ " : "⬆ ") + msg;
  toast.classList.add("visible");

  // Animate bar from 100% to 0 over 4s
  bar.style.transition = "none";
  bar.style.width = "100%";
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      bar.style.transition = "width 4s linear";
      bar.style.width = "0%";
    });
  });

  clearTimeout(_mobToastTimer);
  _mobToastTimer = setTimeout(()=>{ _hideMobToast(); _mobUndoData = null; }, 4000);
}

function _hideMobToast(){
  clearTimeout(_mobToastTimer);
  const toast = document.getElementById("mob-toast");
  if(toast) toast.classList.remove("visible");
}

async function mobUndo(){
  if(!_mobUndoData){ _hideMobToast(); return; }
  _hideMobToast();
  const {wineId, prevGiacenza, prevLots, movId} = _mobUndoData;
  _mobUndoData = null;

  // Restore wine
  wines = wines.map(w => w.id===wineId ? {...w, giacenza:prevGiacenza, lots:prevLots} : w);
  // Remove movement
  movements = movements.filter(m => m.id !== movId);

  // Write to Supabase immediately
  _saveLocalBackup();
  if(_sb){
    _setDbStatus("sync","Sincronizzazione…");
    try{
      // Prima ripristina la giacenza (blob), poi tombstona il movimento sul ledger:
      // così lo stock è corretto anche se il tombstone fallisce (niente resurrezione).
      await _sbUpsert("cm_wines", {user_id:DB_USER, data:wines});
      await _flushMovementsV2(); // il movimento rimosso viene tombstonato (delta-only)
      _setDbStatus("ok","Sincronizzato");
    }catch(e){ _setDbStatus("err","Errore sync"); }
  }

  // Log undo
  const ts = new Date().toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
  _mobLog = _mobLog.map(e => e.movId === movId ? {...e, annullato:true} : e);
  _mobLog = [{ts, desc:"↩ Annullato", annullato:false, movId:null, wineId:null, qty:0}, ..._mobLog];
  _renderMobLog();
  _renderMobList();
  _renderMobStorico();
  updateSidebar();
}

// ─── MOBILE STORICO SCARICHI ──────────────────────────────────────────────────

var _mobView = "scarico"; // "scarico" | "storico"
var _sheetMovId = null;
var _sheetQty = 1;

function _injectMobStoricoDom(){
  const screen = document.getElementById("mob-screen");
  if(!screen) return;

  // Trova il contenitore principale del mob (primo child flex-col dopo header)
  // Struttura attesa: mob-screen > [mob-header] [mob-body/main-area]
  // Iniettiamo tab bar appena prima di mob-list (o del suo contenitore)
  const mobList = document.getElementById("mob-list");
  if(!mobList) return;

  // Wrap mob-list + mob-empty in un pane scarico
  const existingParent = mobList.parentNode;

  // Crea tab bar
  const tabBar = document.createElement("div");
  tabBar.id = "mob-tab-bar";
  tabBar.innerHTML = `
    <button class="mob-tab-btn active" id="mob-tab-scarico" onclick="mobSwitchView('scarico')">🍾 Scarico</button>
    <button class="mob-tab-btn" id="mob-tab-storico" onclick="mobSwitchView('storico')">📋 Storico</button>`;

  // Crea storico pane
  const storicoPaneHTML = `
    <div id="mob-storico-pane">
      <div class="mob-stor-header">
        <span class="mob-stor-header-label">Serata</span>
        <span class="mob-stor-header-val" id="mob-stor-totale">0 bottiglie</span>
      </div>
      <div id="mob-storico-list"></div>
    </div>`;

  // Trova scarico pane (il contenitore di mob-list)
  // Avvolgi mobList e mob-empty in un div#mob-scarico-pane
  const scaricoPane = document.createElement("div");
  scaricoPane.id = "mob-scarico-pane";
  existingParent.insertBefore(scaricoPane, mobList);
  scaricoPane.appendChild(mobList);
  const emptyEl = document.getElementById("mob-empty");
  if(emptyEl) scaricoPane.appendChild(emptyEl);

  // Inserisci tab bar prima dello scarico pane
  existingParent.insertBefore(tabBar, scaricoPane);

  // Inserisci storico pane dopo scarico pane
  scaricoPane.insertAdjacentHTML("afterend", storicoPaneHTML);

  // Bottom sheet overlay + sheet
  document.body.insertAdjacentHTML("beforeend", `
    <div id="mob-sheet-overlay" onclick="mobCloseSheet()"></div>
    <div id="mob-edit-sheet">
      <div class="mob-sheet-handle"></div>
      <div class="mob-sheet-title">Modifica quantità</div>
      <div class="mob-sheet-wine" id="mob-sheet-wine-name">—</div>
      <div class="mob-sheet-stepper">
        <button class="mob-sheet-step-btn" onclick="mobSheetStep(-1)">−</button>
        <span id="mob-sheet-val">1</span>
        <button class="mob-sheet-step-btn" onclick="mobSheetStep(1)">+</button>
      </div>
      <div class="mob-sheet-actions">
        <button class="mob-sheet-cancel" onclick="mobCloseSheet()">Annulla</button>
        <button class="mob-sheet-confirm" onclick="mobConfirmEdit()">Salva</button>
      </div>
    </div>`);
}

function mobSwitchView(view){
  _mobView = view;
  const scarPane = document.getElementById("mob-scarico-pane");
  const storPane = document.getElementById("mob-storico-pane");
  const tabScar = document.getElementById("mob-tab-scarico");
  const tabStor = document.getElementById("mob-tab-storico");
  if(!scarPane || !storPane) return;
  if(view === "storico"){
    scarPane.style.display = "none";
    storPane.style.display = "flex";
    storPane.style.flexDirection = "column";
    tabScar.classList.remove("active");
    tabStor.classList.add("active");
    _renderMobStorico();
  } else {
    scarPane.style.display = "flex";
    scarPane.style.flexDirection = "column";
    storPane.style.display = "none";
    tabScar.classList.add("active");
    tabStor.classList.remove("active");
  }
  // Aggiorna badge numero sul tab storico
  _updateStoricoBadge();
}

function _updateStoricoBadge(){
  const tabStor = document.getElementById("mob-tab-storico");
  if(!tabStor) return;
  const count = _mobLog.filter(e => e.movId && !e.annullato).length;
  tabStor.textContent = count > 0 ? `📋 Storico (${count})` : "📋 Storico";
}

function _renderMobStorico(){
  const el = document.getElementById("mob-storico-list");
  const totEl = document.getElementById("mob-stor-totale");
  if(!el) return;

  const righe = _mobLog.filter(e => e.movId); // solo scarichi reali (no "↩ Annullato")
  const totBt = righe.filter(e => !e.annullato).reduce((s, e) => s + (e.qty||0), 0);
  if(totEl) totEl.textContent = totBt > 0 ? `${totBt} bottiglie` : "0 bottiglie";

  _updateStoricoBadge();

  if(righe.length === 0){
    el.innerHTML = `<div class="mob-stor-empty">Nessuno scarico registrato<br><span style="font-size:10px;opacity:.5">Gli scarichi di questa sessione appariranno qui</span></div>`;
    return;
  }

  el.innerHTML = righe.map(entry => {
    const wine = wines.find(w => w.id === entry.wineId);
    const wineName = wine ? (wine.nome + (wine.annata ? " " + wine.annata : "")) : entry.desc;
    const produttore = wine ? (wine.produttore || "") : "";
    const isAnnullato = entry.annullato;

    return `<div class="mob-stor-row${isAnnullato ? " annullato" : ""}" data-movid="${entry.movId}">
      <div class="mob-stor-info">
        <div class="mob-stor-name">${h(wineName)}</div>
        <div class="mob-stor-meta">${entry.ts}${produttore ? " · " + h(produttore) : ""}${isAnnullato ? " · <em>annullato</em>" : ""}</div>
      </div>
      <div class="mob-stor-qty">${entry.qty}</div>
      <div class="mob-stor-actions">
        ${isAnnullato
          ? `<span class="mob-stor-annullato-badge">Annullato</span>`
          : `<button class="mob-stor-btn mob-stor-btn-edit" onclick="mobOpenSheet('${entry.movId}')" title="Modifica">✏️</button>
             <button class="mob-stor-btn mob-stor-btn-del" onclick="mobAnnullaStorico('${entry.movId}')" title="Annulla">✕</button>`
        }
      </div>
    </div>`;
  }).join("");
}

async function mobAnnullaStorico(movId){
  const entry = _mobLog.find(e => e.movId === movId);
  if(!entry || entry.annullato) return;

  const {wineId, prevGiacenza, prevLots} = entry;

  // Restore wine state
  wines = wines.map(w => w.id === wineId ? {...w, giacenza:prevGiacenza, lots:prevLots} : w);
  movements = movements.filter(m => m.id !== movId);

  // Marca come annullato nel log
  _mobLog = _mobLog.map(e => e.movId === movId ? {...e, annullato:true} : e);

  _saveLocalBackup();
  if(_sb){
    _setDbStatus("sync","Sincronizzazione…");
    try{
      await _sbUpsert("cm_wines", {user_id:DB_USER, data:wines});
      await _flushMovementsV2();
      _setDbStatus("ok","Sincronizzato");
    }catch(e){ _setDbStatus("err","Errore sync"); }
  }

  const wine = wines.find(w => w.id === wineId);
  const wineName = wine ? wine.nome : "";
  const ts = new Date().toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
  _mobLog = [{ts, desc:`↩ Annullato: ${wineName}`, annullato:false, movId:null, wineId:null, qty:0}, ..._mobLog];

  _renderMobLog();
  _renderMobList();
  _renderMobStorico();
  updateSidebar();

  // Feedback toast
  _showMobToast(`↩ Annullato: ${wineName}`);
}

function mobOpenSheet(movId){
  const entry = _mobLog.find(e => e.movId === movId);
  if(!entry || entry.annullato) return;
  _sheetMovId = movId;
  _sheetQty = entry.qty || 1;

  const wine = wines.find(w => w.id === entry.wineId);
  const wineName = wine ? (wine.nome + (wine.annata ? " " + wine.annata : "")) : entry.desc;

  const nameEl = document.getElementById("mob-sheet-wine-name");
  const valEl = document.getElementById("mob-sheet-val");
  if(nameEl) nameEl.textContent = wineName;
  if(valEl) valEl.textContent = _sheetQty;

  document.getElementById("mob-edit-sheet").classList.add("open");
  document.getElementById("mob-sheet-overlay").classList.add("open");
}

function mobCloseSheet(){
  _sheetMovId = null;
  document.getElementById("mob-edit-sheet").classList.remove("open");
  document.getElementById("mob-sheet-overlay").classList.remove("open");
}

function mobSheetStep(delta){
  const entry = _sheetMovId ? _mobLog.find(e => e.movId === _sheetMovId) : null;
  const wine = entry ? wines.find(w => w.id === entry.wineId) : null;
  // Max = giacenza attuale (post-ripristino) + qty già scaricata (perché stiamo rimpiazzando)
  const curGiacenza = wine ? (parseInt(wine.giacenza)||0) : 999;
  const origQty = entry ? (entry.qty||1) : 1;
  const maxQty = curGiacenza + origQty; // giacenza disponibile se annullassimo il mov corrente
  _sheetQty = Math.max(1, Math.min(_sheetQty + delta, maxQty));
  const valEl = document.getElementById("mob-sheet-val");
  if(valEl) valEl.textContent = _sheetQty;
}

async function mobConfirmEdit(){
  if(!_sheetMovId) return;
  const movId = _sheetMovId;
  const newQty = _sheetQty;
  mobCloseSheet();

  const entry = _mobLog.find(e => e.movId === movId);
  if(!entry) return;

  // 1. Annulla il vecchio movimento (ripristina giacenza + lots)
  wines = wines.map(w => w.id === entry.wineId ? {...w, giacenza:entry.prevGiacenza, lots:entry.prevLots} : w);
  movements = movements.filter(m => m.id !== movId);
  _mobLog = _mobLog.map(e => e.movId === movId ? {...e, annullato:true} : e);

  // 2. Registra nuovo scarico con qty aggiornata
  await registraMovimentoMobileQty(entry.wineId, -newQty);
  // registraMovimentoMobileQty aggiunge già il nuovo entry in _mobLog e chiama _renderMobStorico

  _renderMobStorico();
}

// ─── MODIFICA MOVIMENTO ───────────────────────────────────────────────────────
let _editMovId = null;

function openMovModal(id){
  const m = movements.find(x => x.id === id);
  if(!m) return;
  _editMovId = id;
  const wMap = Object.fromEntries(wines.map(w=>[w.id,w]));
  const wObj = wMap[m.wineId];
  const allFornitori = [...new Set([...wines.map(w=>w.distributore),...movements.map(x=>x.fornitore)].filter(Boolean))].sort();

  document.getElementById("mov-edit-body").innerHTML = `
    <div class="form-grid g2" style="margin-bottom:12px">
      <div>
        <label class="form-label">Data</label>
        <input class="form-input" type="date" id="me-data" value="${h(m.data)}">
      </div>
      <div>
        <label class="form-label">Tipo</label>
        <select class="form-select" id="me-tipo">
          <option value="carico" ${m.tipo==="carico"?"selected":""}>📦 Carico</option>
          <option value="scarico" ${m.tipo==="scarico"?"selected":""}>🍾 Scarico</option>
        </select>
      </div>
    </div>
    <div class="form-grid g2" style="margin-bottom:12px">
      <div>
        <label class="form-label">Fornitore</label>
        <datalist id="me-forn-dl">${allFornitori.map(v=>`<option value="${h(v)}">`).join("")}</datalist>
        <input class="form-input" id="me-fornitore" list="me-forn-dl" value="${h(m.fornitore||'')}" placeholder="es. Vini Italiani Srl">
      </div>
      <div>
        <label class="form-label">Produttore</label>
        <input class="form-input" id="me-produttore" value="${h(m.produttore||wObj?.produttore||'')}" placeholder="es. Giacomo Conterno">
      </div>
    </div>
    <div class="form-row" style="margin-bottom:12px">
      <label class="form-label">Nazione</label>
      <input class="form-input" id="me-nazione" value="${h(m.nazione||wObj?.nazione||'')}" placeholder="es. Italia">
    </div>
    <div class="form-row" style="margin-bottom:12px">
      <label class="form-label">Nome Vino</label>
      <input class="form-input" id="me-winename" value="${h(m.wineName||'')}" placeholder="Nome vino">
    </div>
    <div class="form-grid g2" style="margin-bottom:12px">
      <div>
        <label class="form-label">Quantità</label>
        <input class="form-input" type="number" inputmode="numeric" pattern="[0-9]*" onfocus="this.select()" min="1" id="me-qty" value="${m.qty}">
      </div>
      <div>
        <label class="form-label">N° Fattura</label>
        <input class="form-input" id="me-fattura" value="${h(m.fattura||'')}" placeholder="FT-2024-001">
      </div>
    </div>
    <div class="form-row" style="margin-bottom:12px">
      <label class="form-label">Note</label>
      <input class="form-input" id="me-note" value="${h(m.note||'')}" placeholder="Note aggiuntive…">
    </div>
    <div style="padding:10px;background:rgba(28,28,30,.6);border:1px solid var(--border);font-size:10px;color:var(--txt4)">
      <span style="color:var(--txt3)">Vino collegato:</span> ${h(wObj?.nome||m.wineName||"—")} · ${h(wObj?.produttore||"—")} · ${wObj?.annata||"N.V."}
      <span style="margin-left:12px;color:var(--txt4)">ID: ${m.id.slice(0,8)}…</span>
    </div>`;

  document.getElementById("mov-edit-backdrop").classList.remove("hidden");
}

function closeMovModal(e){
  if(e && e.target !== document.getElementById("mov-edit-backdrop")) return;
  document.getElementById("mov-edit-backdrop").classList.add("hidden");
  _editMovId = null;
}

function saveMovEdit(){
  if(!_editMovId) return;
  const get = id => document.getElementById(id)?.value ?? "";
  const qty = parseInt(get("me-qty"))||0;
  if(qty <= 0){ notify("⚠️ Inserisci una quantità valida","err"); return; }

  const oldMov = movements.find(m => m.id === _editMovId);
  const oldTipo = oldMov?.tipo;
  const oldQty  = oldMov?.qty || 0;
  const oldData = oldMov?.data || "";
  const newTipo = get("me-tipo");
  const newQty  = qty;
  const newData = get("me-data") || oldData;

  // B1 + B6 FIX: ricalcola giacenza E lotti FIFO se tipo, qty O data cambiano.
  // La data cambia l'ordine cronologico del replay FIFO, quindi è necessario
  // rifare il replay anche in quel caso (prima era ignorata — bug B6).
  if(oldMov && (oldTipo !== newTipo || oldQty !== newQty || oldData !== newData)){
    const affectedId = oldMov.wineId;
    // Aggiorna il movimento in memoria prima del replay (qty/tipo/data provvisori)
    const provisionalMovs = movements.map(m =>
      m.id === _editMovId ? {...m, tipo: newTipo, qty: newQty, data: newData} : m
    );
    // Reset solo il vino coinvolto
    wines = wines.map(w => w.id === affectedId ? {...w, giacenza:0, lots:[]} : w);
    // Replay cronologico di tutti i movimenti relativi a quel vino
    const sorted = provisionalMovs
      .filter(m => m.wineId === affectedId)
      .sort((a,b) => a.data.localeCompare(b.data) || (a.ts||0)-(b.ts||0));
    sorted.forEach(m => {
      const wIdx = wines.findIndex(w => w.id === affectedId);
      if(wIdx < 0) return;
      const w = wines[wIdx];
      const q = parseInt(m.qty)||0;
      if(q <= 0) return;
      if(m.tipo === "carico"){
        const pAcq = parseFloat(m.prezzoAcqLotto)||parseFloat(w.prezzoAcq)||0;
        const lot = {id:m.id+"_lot",data:m.data,fattura:m.fattura||"",fornitore:m.fornitore||"",prezzoAcq:pAcq,iva:w.iva||22,qtyCaricata:q,qtyRimanente:q};
        wines[wIdx] = {...w, giacenza:w.giacenza+q, lots:[...(w.lots||[]),lot]};
      } else {
        let rem = q;
        const updLots = (w.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c};});
        wines[wIdx] = {...w, giacenza:Math.max(0,w.giacenza-q), lots:updLots};
      }
    });
    // Applica anche le fallate di quel vino (FIFO consistency)
    fallate.filter(f => f.wineId === affectedId).forEach(f => {
      const wIdx = wines.findIndex(w => w.id === affectedId);
      if(wIdx < 0) return;
      const w = wines[wIdx]; const q = parseInt(f.qty)||0;
      let rem = q;
      const updLots = (w.lots||[]).map(l=>{if(rem<=0||l.qtyRimanente<=0)return l;const c=Math.min(rem,l.qtyRimanente);rem-=c;return{...l,qtyRimanente:l.qtyRimanente-c};});
      wines[wIdx] = {...w, giacenza:Math.max(0,w.giacenza-q), lots:updLots};
    });
  }

  movements = movements.map(m => {
    if(m.id !== _editMovId) return m;
    return {
      ...m,
      data:     get("me-data") || m.data,
      tipo:     newTipo,
      qty:      newQty,
      nazione:  get("me-nazione") || m.nazione || "",
      fattura:  get("me-fattura"),
      fornitore:get("me-fornitore"),
      produttore:get("me-produttore"),
      wineName: get("me-winename") || m.wineName,
      note:     get("me-note"),
    };
  });

  document.getElementById("mov-edit-backdrop").classList.add("hidden");
  _editMovId = null;
  scheduleSave();
  // PATCH: flush immediato — saveMovEdit modifica giacenza via FIFO replay
  clearTimeout(saveTimer); _flushSave();
  notify("✅ Movimento aggiornato");
  render();
}

function exportBilancioCSV(){
  const dateStr=new Date().toLocaleDateString("it-IT");
  const wineMap=Object.fromEntries(wines.map(w=>[w.id,w]));
  const carichi=[...movements].filter(m=>m.tipo==="carico").sort((a,b)=>a.data.localeCompare(b.data));
  const fallSorted=[...fallate].sort((a,b)=>a.data.localeCompare(b.data));
  let totImpAcq=0,totIvaAcq=0;carichi.forEach(m=>{const w=wineMap[m.wineId];const p=parseFloat(m.prezzoAcqLotto)||parseFloat(w?.prezzoAcq)||0;const imp=p*m.qty;totImpAcq+=imp;totIvaAcq+=imp*((parseInt(w?.iva)||22)/100);});
  let totValStock=0,totIvaStock=0;wines.forEach(w=>{const vc=calcValore(w);totValStock+=vc;totIvaStock+=vc*((parseInt(w.iva)||22)/100);});
  let totPerdite=0,totIvaPerd=0;fallSorted.forEach(f=>{const w=wineMap[f.wineId];const p=parseFloat(w?.prezzoAcq)||0;const vc=p*f.qty;totPerdite+=vc;totIvaPerd+=vc*((parseInt(w?.iva)||22)/100);});
  const s=getStats();const lines=[];
  const row=(...cols)=>cols.map(v=>esc(v)).join(";");
  lines.push(row("BILANCIO DI MAGAZZINO — "+dateStr)); lines.push("");
  lines.push(row("A — SOMMARIO","","Imponibile","IVA","Totale IVA inclusa"));
  lines.push(row("Totale acquisti (carichi)","",fmtN(totImpAcq),fmtN(totIvaAcq),fmtN(totImpAcq+totIvaAcq)));
  lines.push(row("Perdite / Fallate","",fmtN(totPerdite),fmtN(totIvaPerd),fmtN(totPerdite+totIvaPerd)));
  lines.push(row("Valore giacenza attuale","",fmtN(totValStock),fmtN(totIvaStock),fmtN(totValStock+totIvaStock)));
  lines.push(row("Valore potenziale di vendita (carta)","",fmtN(s.valoreCarta),"",fmtN(s.valoreCarta)));
  lines.push(""); lines.push("");
  lines.push(row("B — GIACENZE AL "+dateStr));
  lines.push(row("Produttore","Nome Vino","Tipologia","Annata","P.Acq","IVA%","P.Carta","Giacenza","Val.Costo","IVA Stock","Val.Carta","Nota Veloce"));
  wines.forEach(w=>{const vc=calcValore(w);lines.push(row(w.produttore,w.nome,w.tipologia,w.annata||"",fmtN(w.prezzoAcq),w.iva+"%",fmtN(w.prezzoCarta),w.giacenza,fmtN(vc),fmtN(vc*(parseInt(w.iva)||22)/100),fmtN(calcValoreCarta(w)),w.noteVeloce||""));});
  lines.push(row("","TOTALE","","","","",wines.reduce((s2,w)=>s2+w.giacenza,0),fmtN(totValStock),fmtN(totIvaStock),fmtN(s.valoreCarta),""));
  lines.push(""); lines.push("");
  lines.push(row("C — REGISTRO ACQUISTI"));
  lines.push(row("Data","N° Fattura","Fornitore","Nome Vino","Annata","Qtà","P.Acq/bt","IVA%","Imponibile","IVA Assolta","Totale Riga"));
  carichi.forEach(m=>{const w=wineMap[m.wineId];const p=parseFloat(m.prezzoAcqLotto)||parseFloat(w?.prezzoAcq)||0;const iva=parseInt(w?.iva)||22;const imp=p*m.qty;const iv=imp*(iva/100);lines.push(row(m.data,m.fattura||"—",m.fornitore||w?.distributore||"—",m.wineName,w?.annata||"",m.qty,fmtN(p),iva+"%",fmtN(imp),fmtN(iv),fmtN(imp+iv)));});
  lines.push(""); lines.push("");
  lines.push(row("D — REGISTRO PERDITE / FALLATE"));
  lines.push(row("Data","Nome Vino","Produttore","Tipologia","Qtà","P.Acq/bt","Val.Costo Perdita","IVA su Perdita","Totale Perdita","Motivazione","Note"));
  fallSorted.forEach(f=>{const w=wineMap[f.wineId];const p=parseFloat(w?.prezzoAcq)||0;const vc=p*f.qty;const iv=vc*((parseInt(w?.iva)||22)/100);lines.push(row(f.data,f.wineName,f.produttore||"",w?.tipologia||"",f.qty,fmtN(p),fmtN(vc),fmtN(iv),fmtN(vc+iv),f.motivo,f.note||""));});
  const blob=new Blob(["\uFEFF"+lines.join("\n")],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  Object.assign(document.createElement("a"),{href:url,download:`bilancio_cantina_${dateStr.replace(/\//g,"-")}.csv`}).click();
  URL.revokeObjectURL(url);
  notify("📊 Bilancio completo esportato");
}

// ─── BACKUP JSON ──────────────────────────────────────────────────────────────
function exportBackupJSON(){
  const dateStr = new Date().toISOString().slice(0,10);
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    wines,
    movements,
    fallate,
    orders,
    alertSoglie,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), {
    href: url,
    download: `cantina-backup-${dateStr}.json`
  }).click();
  URL.revokeObjectURL(url);
  notify("💾 Backup esportato");
}

// ─── IMPORT NAZIONI DA ODS/XLSX ──────────────────────────────────────────────
// Normalizza stringa: minuscolo, trim, rimuove accenti, collassa spazi multipli, rimuove articoli iniziali
function _normStr(s){
  return String(s||"")
    .toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"") // rimuove accenti
    .replace(/\s+/g," ")                              // spazi multipli
    .replace(/^(il |la |lo |l'|i |le |gli |the |la |le |les |les |de |di )/,"") // articoli iniziali
    .trim();
}

function importNazioniDaFile(event){
  const file=event.target.files[0];
  if(!file) return;
  event.target.value="";
  const reader=new FileReader();
  reader.onload=function(e){
    try{
      const wb=XLSX.read(e.target.result,{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
      let hdrIdx=rows.findIndex(r=>r.some(c=>String(c).toLowerCase()==="nazione"));
      if(hdrIdx<0){notify("⚠️ Colonna 'Nazione' non trovata nel file","err");return;}
      const hdr=rows[hdrIdx].map(c=>String(c).toLowerCase().trim());
      const iNaz=hdr.indexOf("nazione");
      const iReg=hdr.indexOf("regione");
      const iDist=["distributore","distributor"].map(k=>hdr.indexOf(k)).find(i=>i>=0)??-1;
      const iProd=["produttore","producer"].map(k=>hdr.indexOf(k)).find(i=>i>=0)??-1;
      const iNome=["nome vino","nome","wine","vino"].map(k=>hdr.indexOf(k)).find(i=>i>=0)??-1;
      if(iNaz<0||iProd<0||iNome<0){notify("⚠️ Colonne richieste non trovate (Produttore, Nome vino, Nazione)","err");return;}

      // Build lookup maps: exact + normalized
      const lookup=new Map();       // "norm_prod§norm_nome" → entry
      const lookupNome=new Map();   // "norm_nome" → entry (solo nome, fallback)
      for(let i=hdrIdx+1;i<rows.length;i++){
        const r=rows[i];
        const prod=String(r[iProd]||"").trim();
        const nome=String(r[iNome]||"").trim();
        const naz=String(r[iNaz]||"").trim();
        const reg=iReg>=0?String(r[iReg]||"").trim():"";
        const dist=iDist>=0?String(r[iDist]||"").trim():"";
        if(!naz) continue;
        const entry={nazione:naz,regione:reg,distributore:dist,prodRaw:prod,nomeRaw:nome};
        if(prod&&nome){
          const k=_normStr(prod)+"§"+_normStr(nome);
          lookup.set(k,entry);
          // anche solo nome normalizzato (per fallback)
          if(!lookupNome.has(_normStr(nome))) lookupNome.set(_normStr(nome),entry);
        }
      }

      let updated=0,updatedFallback=0,notFound=[];
      wines=wines.map(w=>{
        // 1) exact normalized match (prod+nome)
        const k=_normStr(w.produttore)+"§"+_normStr(w.nome);
        let match=lookup.get(k);
        let source="exact";
        // 2) fallback: solo nome normalizzato
        if(!match){
          match=lookupNome.get(_normStr(w.nome));
          source="nome";
        }
        if(match){
          if(source==="exact") updated++; else updatedFallback++;
          return{...w,
            nazione:match.nazione||w.nazione||"",
            regione:w.regione||match.regione||"",
            distributore:w.distributore||match.distributore||""
          };
        }
        notFound.push(w.produttore+" – "+w.nome);
        return w;
      });
      scheduleSave(); render();
      let msg=`✅ Nazioni aggiornate: ${updated} (exact) + ${updatedFallback} (solo nome)`;
      if(notFound.length) msg+=` | ⚠️ Non trovati: ${notFound.length} (${notFound.slice(0,3).join(", ")}${notFound.length>3?"…":""})`;
      notify(msg, (updated+updatedFallback)>0?"ok":"warn");
      if(notFound.length) notify(`⚠️ Non trovati nell'import: ${notFound.slice(0,5).join(", ")}${notFound.length>5?"…":""}`, "warn");
    }catch(err){notify("❌ Errore lettura file: "+err.message,"err");}
  };
  reader.readAsArrayBuffer(file);
}

// ─── IMPORT BACKUP JSON ──────────────────────────────────────────────────────
function importBackupJSON(event){
  const file = event.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if(!data.wines || !Array.isArray(data.wines)) throw new Error("Formato non valido");
      // _confirmModal è non-blocking: la catch gestisce solo il parse JSON
      _confirmModal(
        `Importare <strong>${data.wines.length} vini</strong>?<br><span style="font-size:11px;color:var(--txt4)">I dati esistenti verranno sostituiti.</span>`,
        "📥 Importa",
        () => {
          wines = data.wines;
          if(data.movements) movements = data.movements;
          if(data.fallate) fallate = data.fallate;
          if(data.orders) orders = data.orders;
          if(data.alertSoglie) alertSoglie = data.alertSoglie;
          // B4: esegui migration per garantire compatibilità con backup da versioni precedenti
          _migrateOrders();
          _migrateWines();
          scheduleSave();
          render();
          notify(`✅ Importati ${wines.length} vini`);
          event.target.value = '';
        },
        'danger'
      );
    } catch(err) {
      notify("❌ Errore: " + err.message, "err");
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ─── NOTE VELOCI ──────────────────────────────────────────────────────────────
let _noteVeloceId = null;
function openNoteVeloce(wineId){
  const w = wines.find(x=>x.id===wineId);
  if(!w) return;
  _noteVeloceId = wineId;
  document.getElementById("nv-wine-name").textContent = w.nome + (w.produttore ? ' — ' + w.produttore : '');
  document.getElementById("nv-text").value = w.noteVeloce || '';
  document.getElementById("note-veloce-backdrop").classList.remove("hidden");
  setTimeout(()=>document.getElementById("nv-text").focus(), 80);
}
function closeNoteVeloce(e){
  if(e && e.target !== document.getElementById("note-veloce-backdrop")) return;
  document.getElementById("note-veloce-backdrop").classList.add("hidden");
  _noteVeloceId = null;
}
function saveNoteVeloce(){
  if(!_noteVeloceId) return;
  const nota = document.getElementById("nv-text").value.trim();
  wines = wines.map(w => w.id===_noteVeloceId ? {...w, noteVeloce: nota} : w);
  document.getElementById("note-veloce-backdrop").classList.add("hidden");
  _noteVeloceId = null;
  scheduleSave();
  notify("📝 Nota salvata");
  render();
}

// ─── TROVA E FONDI DUPLICATI ──────────────────────────────────────────────────
let _dupGroups = []; // array di gruppi [[wine, wine, ...], ...]
let _dupGroupIdx = 0; // gruppo attualmente visualizzato nel modal

function _normDup(s){
  return String(s||"").toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")  // rimuovi accenti
    .replace(/[-_''.]/g," ")                           // punteggiatura → spazio
    .replace(/\b(le|la|il|lo|i|gli|le|di|del|della|dei|degli|delle|de|du|von|van|the|domaine|chateau|clos|mas|finca)\b/g,"") // stopword vino
    .replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
}

// Trigram similarity [0..1] tra due stringhe normalizzate
function _trigramSim(a, b){
  if(!a && !b) return 1;
  if(!a || !b) return 0;
  const tg = s => {
    const p = "  "+s+"  ";
    const set = new Set();
    for(let i=0;i<p.length-2;i++) set.add(p.slice(i,i+3));
    return set;
  };
  const ta = tg(a), tb = tg(b);
  let inter = 0;
  ta.forEach(t => { if(tb.has(t)) inter++; });
  return (2*inter) / (ta.size + tb.size);
}

// Soglia fuzzy: 0.82 = ~82% di trigram in comune (empiricamente calibrato su nomi vino)
const _DUP_FUZZY_THRESHOLD = 0.82;

function _dupExactKey(w){
  return _normDup(w.produttore) + "|" + _normDup(w.nome) + "|" + _normDup(w.annata||"nv");
}

function _findDuplicateGroups(){
  // ── PASS 1: match esatto su chiave normalizzata ──────────────────────────────
  const exactMap = new Map();
  wines.forEach(w => {
    const k = _dupExactKey(w);
    if(!exactMap.has(k)) exactMap.set(k,[]);
    exactMap.get(k).push(w);
  });
  const exactGroups = [...exactMap.values()].filter(g => g.length >= 2);

  // Set degli ID già raggruppati in pass1
  const grouped = new Set(exactGroups.flatMap(g => g.map(w => w.id)));

  // Arricchisci ogni gruppo con metadata match
  const result = exactGroups.map(g => ({ wines: g, score: 1, matchType: "exact" }));

  // ── PASS 2: fuzzy — confronta coppie tra vini non ancora raggruppati ────────
  const ungrouped = wines.filter(w => !grouped.has(w.id));

  // Chiave di pre-bucket: stessa tipologia O primo trigram produttore — riduce O(n²)
  // Usiamo il primo token di produttore normalizzato come bucket approssimativo
  const buckets = new Map();
  ungrouped.forEach(w => {
    const prod = _normDup(w.produttore);
    // Bucket = prime 3 lettere produttore (fallback "???" per vuoto)
    const bk = prod.slice(0,3) || "???";
    if(!buckets.has(bk)) buckets.set(bk,[]);
    buckets.get(bk).push(w);
  });

  const fuzzyGrouped = new Set();
  const fuzzyGroups = [];

  // Confronto dentro ogni bucket + bucket adiacenti (single-char tolerance)
  const allBuckets = [...buckets.keys()];
  allBuckets.forEach(bk => {
    const candidates = buckets.get(bk);
    // includi bucket che differiscono di 1 char nella prima lettera (es "mon"/"bon")
    // ma per sicurezza confrontiamo solo dentro lo stesso bucket
    for(let i=0;i<candidates.length;i++){
      for(let j=i+1;j<candidates.length;j++){
        const wi = candidates[i], wj = candidates[j];
        if(fuzzyGrouped.has(wi.id) || fuzzyGrouped.has(wj.id)) continue;

        const normNomeI = _normDup(wi.nome), normNomeJ = _normDup(wj.nome);
        const normProdI = _normDup(wi.produttore), normProdJ = _normDup(wj.produttore);

        // Produttore deve essere simile (≥0.75) — filtro forte per evitare falsi positivi
        const prodSim = _trigramSim(normProdI, normProdJ);
        if(prodSim < 0.75) continue;

        // Nome: trigram similarity principale
        const nomeSim = _trigramSim(normNomeI, normNomeJ);

        // Score composito: nome pesa 70%, produttore 30%
        const score = nomeSim * 0.7 + prodSim * 0.3;
        if(score < _DUP_FUZZY_THRESHOLD) continue;

        // Annata: se entrambe presenti e diverse, abbassa lo score (non blocca)
        const annI = (wi.annata||"").trim(), annJ = (wj.annata||"").trim();
        const annataConflict = annI && annJ && annI !== annJ;
        if(annataConflict && score < 0.91) continue; // annate diverse → soglia più alta

        fuzzyGrouped.add(wi.id);
        fuzzyGrouped.add(wj.id);
        fuzzyGroups.push({ wines: [wi, wj], score: Math.round(score*100)/100, matchType: "fuzzy" });
      }
    }
  });

  return [...result, ...fuzzyGroups];
}

function openDuplicatiModal(){
  _dupGroups = _findDuplicateGroups();
  if(_dupGroups.length === 0){
    notify("✅ Nessun duplicato trovato nel database");
    return;
  }
  _dupGroupIdx = 0;
  _renderDupModal();
  document.getElementById("dup-modal-backdrop").classList.remove("hidden");
}

function closeDuplicatiModal(e){
  if(e && e.target !== document.getElementById("dup-modal-backdrop")) return;
  document.getElementById("dup-modal-backdrop").classList.add("hidden");
  _dupGroups = [];
  _dupGroupIdx = 0;
}

function _renderDupModal(){
  const total = _dupGroups.length;
  const grp = _dupGroups[_dupGroupIdx];
  const group = grp.wines;
  const matchType = grp.matchType;
  const score = grp.score;

  // Header contatore
  document.getElementById("dup-counter").textContent = `Gruppo ${_dupGroupIdx+1} di ${total}`;
  document.getElementById("dup-prev-btn").disabled = _dupGroupIdx === 0;
  document.getElementById("dup-next-btn").disabled = _dupGroupIdx === total-1;

  const badgeHtml = matchType === "exact"
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;background:rgba(48,209,88,.15);color:#30D158;letter-spacing:.06em">✓ ESATTO</span>`
    : `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;background:rgba(255,159,10,.15);color:var(--amber);letter-spacing:.06em">~ FUZZY ${Math.round(score*100)}%</span>`;

  // Corpo: tabella dei vini nel gruppo con campi selezionabili
  const fields = [
    {key:"produttore",label:"Produttore"},
    {key:"nome",label:"Nome vino"},
    {key:"annata",label:"Annata"},
    {key:"tipologia",label:"Tipologia"},
    {key:"regione",label:"Regione"},
    {key:"nazione",label:"Nazione"},
    {key:"zona",label:"Zona/Cru"},
    {key:"vitigni",label:"Vitigni"},
    {key:"distributore",label:"Distributore"},
    {key:"prezzoAcq",label:"P.Acquisto"},
    {key:"prezzoCarta",label:"P.Carta"},
    {key:"iva",label:"IVA %"},
  ];

  // Conta i movimenti per wine ID in O(n) una volta sola, evitando O(n×m) nel forEach
  const _movCountMap = {};
  movements.forEach(m=>{ _movCountMap[m.wineId] = (_movCountMap[m.wineId]||0) + 1; });

  // Header riga con nome vino+produttore per ogni duplicato
  let headerCols = `<th style="width:120px;color:var(--txt4);font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:500;padding:8px 10px;text-align:left">Campo</th>`;
  group.forEach((w,i) => {
    const giac = w.giacenza||0;
    const movCount = _movCountMap[w.id]||0;
    headerCols += `<th style="padding:8px 10px;text-align:left;min-width:180px">
      <div style="font-size:12px;color:var(--txt);font-weight:600">${h(w.nome)}</div>
      <div style="font-size:10px;color:var(--txt3);margin-top:2px">${h(w.produttore)}</div>
      <div style="font-size:10px;color:var(--amber);margin-top:3px">⬢ ${giac} bt &nbsp;·&nbsp; ${movCount} mov.</div>
    </th>`;
  });

  // Righe campi
  let rows = "";
  fields.forEach(f => {
    const vals = group.map(w => String(w[f.key]||""));
    const allSame = vals.every(v => v === vals[0]);
    rows += `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:7px 10px;font-size:10px;color:var(--txt4);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap">${f.label}</td>`;
    group.forEach((w,i) => {
      const val = String(w[f.key]||"—");
      const isDiff = !allSame;
      rows += `<td style="padding:7px 10px">
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer">
          <input type="radio" name="dup-field-${f.key}" value="${i}" style="accent-color:#bf5fff;cursor:pointer" ${i===0?"checked":""}>
          <span style="font-size:12px;${isDiff?"color:var(--txt)":"color:var(--txt3)"}">${h(val)}</span>
        </label>
      </td>`;
    });
    rows += `</tr>`;
  });

  // Riga giacenza (solo info, non selezionabile — viene sommata)
  rows += `<tr style="border-bottom:1px solid var(--border);background:rgba(255,159,10,.05)">
    <td style="padding:7px 10px;font-size:10px;color:var(--amber);letter-spacing:.08em;text-transform:uppercase">Giacenza</td>`;
  group.forEach(w => {
    rows += `<td style="padding:7px 10px;font-size:12px;color:var(--amber);font-weight:600">${w.giacenza||0} bt <span style="font-size:9px;color:var(--txt4)">(verrà sommata)</span></td>`;
  });
  rows += `</tr>`;

  // Riga lotti
  rows += `<tr style="background:rgba(48,209,88,.04)">
    <td style="padding:7px 10px;font-size:10px;color:#30D158;letter-spacing:.08em;text-transform:uppercase">Lotti FIFO</td>`;
  group.forEach(w => {
    const lots = (w.lots||[]).filter(l=>l.qtyRimanente>0);
    rows += `<td style="padding:7px 10px;font-size:11px;color:#30D158">${lots.length > 0 ? lots.length+" lott"+(lots.length===1?"o":"i")+" attivi" : "nessuno"} <span style="font-size:9px;color:var(--txt4)">(verranno uniti)</span></td>`;
  });
  rows += `</tr>`;

  document.getElementById("dup-modal-body").innerHTML = `
    <div style="margin-bottom:12px;padding:10px 14px;background:rgba(191,95,255,.08);border:1px solid rgba(191,95,255,.2);border-radius:8px;font-size:11px;color:var(--txt3);line-height:1.7;display:flex;align-items:flex-start;gap:10px">
      <div style="flex:1">Seleziona per ogni campo il valore da tenere nel vino risultante.<br>
      <span style="color:var(--amber)">Giacenze e lotti FIFO</span> vengono sempre <strong style="color:var(--txt)">sommati automaticamente</strong>. Movimenti e fallate vengono riepilogati sul vino tenuto.</div>
      <div style="flex-shrink:0;padding-top:2px">${badgeHtml}</div>
    </div>
    <div style="overflow-x:auto;max-height:55vh;overflow-y:auto">
      <table style="border-collapse:collapse;width:100%;min-width:500px">
        <thead style="background:var(--bg3);position:sticky;top:0;z-index:1"><tr>${headerCols}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function dupPrev(){
  if(_dupGroupIdx > 0){ _dupGroupIdx--; _renderDupModal(); }
}
function dupNext(){
  if(_dupGroupIdx < _dupGroups.length-1){ _dupGroupIdx++; _renderDupModal(); }
}

function mergeDuplicati(){
  const grp = _dupGroups[_dupGroupIdx];
  if(!grp || !grp.wines || grp.wines.length < 2){ notify("Gruppo non valido","err"); return; }
  const group = grp.wines;

  const fields = ["produttore","nome","annata","tipologia","regione","nazione","zona","vitigni","distributore","prezzoAcq","prezzoCarta","iva"];

  // Ricostruisce merged dai radio button selezionati
  const mergedWine = {};
  fields.forEach(f => {
    const selected = document.querySelector(`input[name="dup-field-${f}"]:checked`);
    const idx = selected ? parseInt(selected.value) : 0;
    mergedWine[f] = group[idx][f] ?? group[0][f];
  });

  // ID da mantenere = vino con più movimenti (o il primo) — lookup O(1) su conteggio pre-calcolato
  const _mergeMovCountMap = {};
  movements.forEach(m=>{ _mergeMovCountMap[m.wineId] = (_mergeMovCountMap[m.wineId]||0) + 1; });
  const movCounts = group.map(w => _mergeMovCountMap[w.id]||0);
  const keepIdx = movCounts.indexOf(Math.max(...movCounts));
  const keepWine = group[keepIdx];
  const removeIds = group.filter((_,i)=>i!==keepIdx).map(w=>w.id);

  // Somma giacenze e unisci lotti
  const totalGiacenza = group.reduce((s,w)=>(s + (parseInt(w.giacenza)||0)),0);
  const allLots = group.flatMap(w=>(w.lots||[]));

  // Unisci price history
  const allHistory = group.flatMap(w=>(w.priceHistory||[]));

  // Wine finale
  const finalWine = {
    ...keepWine,
    ...mergedWine,
    id: keepWine.id,
    giacenza: totalGiacenza,
    lots: allLots,
    priceHistory: allHistory.sort((a,b)=>(a.ts||0)-(b.ts||0)),
  };

  // Aggiorna movimenti e fallate: rilega i wineId rimossi al keepWine
  movements = movements.map(m =>
    removeIds.includes(m.wineId) ? {...m, wineId:keepWine.id, wineName:finalWine.nome, produttore:finalWine.produttore} : m
  );
  fallate = fallate.map(f =>
    removeIds.includes(f.wineId) ? {...f, wineId:keepWine.id, wineName:finalWine.nome, produttore:finalWine.produttore} : f
  );

  // Aggiorna lista vini: sostituisci keepWine, rimuovi gli altri
  wines = wines.map(w => w.id===keepWine.id ? finalWine : w).filter(w=>!removeIds.includes(w.id));

  scheduleSave();

  // Rimuovi il gruppo fuso dalla lista e aggiorna il modal
  _dupGroups.splice(_dupGroupIdx, 1);
  notify(`✅ Vini fusi — ${removeIds.length} duplicat${removeIds.length===1?"o":"i"} rimoss${removeIds.length===1?"o":"i"}`);

  if(_dupGroups.length === 0){
    document.getElementById("dup-modal-backdrop").classList.add("hidden");
    _dupGroupIdx = 0;
    render();
    notify("✅ Tutti i duplicati sono stati risolti");
  } else {
    if(_dupGroupIdx >= _dupGroups.length) _dupGroupIdx = _dupGroups.length-1;
    _renderDupModal();
    render();
  }
}

// ─── EVENT DELEGATION — INVENTARIO ───────────────────────────────────────────
// Click singolo  → seleziona la riga (highlight + topbar actions)
// Doppio click   → apre la modal di MODIFICA (openWineModal) su tutta la riga
document.getElementById("content").addEventListener("click", function(e){
  if(e.target.closest("button,input,select,a,label")) return;
  const tr = e.target.closest("tr[data-wine-id]");
  if(!tr) return;
  selectWineRow(tr.dataset.wineId);
});

document.getElementById("content").addEventListener("dblclick", function(e){
  if(e.target.closest("button,input,select,a,label")) return;
  const tr = e.target.closest("tr[data-wine-id]");
  if(!tr) return;
  e.preventDefault();
  e.stopPropagation();
  openWineModal(tr.dataset.wineId);
});

// ─── BRIDGE ORDINI_TESTATA → renderOrdini ────────────────────────────────────
/**
 * Carica le bozze da ordini_testata + ordini_righe in background.
 * Aggiorna _bozzeSb e fa re-render della sezione ordini se siamo lì.
 * Chiamata ogni volta che si apre la sezione Ordini.
 */
async function _loadBozzeSb() {
  if (!_sb) return;
  try {
    const { data: testate, error } = await _sb
      .from('ordini_testata')
      .select('id, distributore, stato, data_ordine, note')
      .eq('user_id', DB_USER)
      .eq('stato', 'bozza');
    if (error || !testate || !testate.length) { _bozzeSb = []; return; }

    // Carica tutte le righe di queste bozze in un'unica query
    const ids = testate.map(t => t.id);
    const { data: righe } = await _sb
      .from('ordini_righe')
      .select('*')
      .in('testata_id', ids);

    // Associa le righe alla testata
    _bozzeSb = testate.map(t => ({
      ...t,
      righe: (righe || []).filter(r => r.testata_id === t.id)
    }));

    // Se siamo ancora nella sezione ordini, aggiorna silenziosamente
    if (section === 'ordini') {
      const c = document.getElementById('content');
      if (c) c.innerHTML = renderOrdini();
      afterRender();
    }
  } catch(e) {
    console.warn('_loadBozzeSb error:', e);
    _bozzeSb = [];
  }
}

// ─── BASI D'ORDINE AUTOMATICHE ────────────────────────────────────────────────

/**
 * Calcola la quantità da ordinare:
 * usa (soglia − giacenza) arrotondata alla cassetta (6bt), fallback 6.
 */
function _qtyDaOrdinare(w) {
  const soglia = parseInt(alertSoglie[w.id] ?? w.soglia ?? 0);
  const giac   = parseInt(w.giacenza ?? 0);
  if (soglia > 0 && soglia > giac) {
    const diff = soglia - giac;
    return Math.ceil(diff / 6) * 6;
  }
  return 6;
}

/**
 * Raggruppa i vini selezionati per distributore,
 * crea/trova la bozza su Supabase e fa batch-insert delle righe.
 * Fallback offline: aggiunge agli ordini locali.
 */
async function creaBasiOrdineDatiSelezionati() {
  if (!selIds.size) { notify('⚠️ Nessun vino selezionato', 'err'); return; }

  const viniSel = [...selIds].map(id => wines.find(w => w.id === id)).filter(Boolean);
  if (!viniSel.length) { notify('⚠️ Vini non trovati', 'err'); return; }

  // Raggruppa per distributore (fallback fornitore → "—")
  const byDist = {};
  viniSel.forEach(w => {
    const dist = (w.distributore || w.fornitore || '—').trim();
    (byDist[dist] = byDist[dist] || []).push(w);
  });

  if (_sb) {
    // ── ONLINE ──────────────────────────────────────────────────────────────
    let totRighe = 0;
    try {
      for (const [dist, wList] of Object.entries(byDist)) {
        // 1. Cerca bozza attiva
        let testataId;
        const { data: existing, error: errSel } = await _sb
          .from('ordini_testata')
          .select('id')
          .eq('user_id', DB_USER)
          .eq('distributore', dist)
          .eq('stato', 'bozza')
          .maybeSingle();
        if (errSel) throw errSel;

        if (existing) {
          testataId = existing.id;
        } else {
          const { data: newT, error: errIns } = await _sb
            .from('ordini_testata')
            .insert({ user_id: DB_USER, distributore: dist, stato: 'bozza',
                      data_ordine: today(), note: '' })
            .select('id')
            .single();
          if (errIns) throw errIns;
          testataId = newT.id;
        }

        // 2. Evita duplicati wine_id già presenti nella bozza
        const { data: giaPres } = await _sb
          .from('ordini_righe')
          .select('wine_id')
          .eq('testata_id', testataId);
        const presentiSet = new Set((giaPres || []).map(r => r.wine_id));

        const nuoveRighe = wList
          .filter(w => !presentiSet.has(w.id))
          .map(w => ({
            testata_id:  testataId,
            wine_id:     w.id,
            nome_vino:   w.nome || '',
            produttore:  w.produttore || '',
            distributore: dist,
            annata:      w.annata || '',
            formato:     parseFloat(w.formato) || 0.75,
            prezzo_acq:  parseFloat(w.prezzoAcq) || null,
            iva:         parseInt(w.iva) || 22,
            qty_ordinata: _qtyDaOrdinare(w),
            note_riga:   ''
          }));

        if (nuoveRighe.length) {
          const { error: errR } = await _sb.from('ordini_righe').insert(nuoveRighe);
          if (errR) throw errR;
          totRighe += nuoveRighe.length;
        }
      }
      notify(`✅ ${totRighe} righe aggiunte a ${Object.keys(byDist).length} bozze ordine`);
      exitSel();
      await _loadBozzeSb(); // aggiorna il bridge così la sezione Ordini è subito allineata
    } catch(err) {
      console.error('creaBasiOrdine error:', err);
      notify('❌ Errore: ' + (err.message || err), 'err');
    }
  } else {
    // ── OFFLINE: popola array locale orders ──────────────────────────────────
    for (const [dist, wList] of Object.entries(byDist)) {
      let ordine = orders.find(o =>
        (o.fornitore || o.distributore || '—') === dist && o.stato === 'attesa'
      );
      if (!ordine) {
        ordine = { id: uid(), fornitore: dist, dataOrdine: today(),
                   note: '', referenze: [], stato: 'attesa' };
        orders.push(ordine);
      }
      const presentiIds = new Set((ordine.referenze || []).map(r => r.wineId));
      wList.filter(w => !presentiIds.has(w.id)).forEach(w => {
        ordine.referenze.push({
          id: uid(), wineId: w.id,
          produttore: w.produttore || '', nomeVino: w.nome || '',
          annata: w.annata || '', tipologia: w.tipologia || '',
          prezzoAcq: w.prezzoAcq || '', iva: w.iva || 22,
          qty: _qtyDaOrdinare(w),
          regione: w.regione || '', zona: w.zona || '',
          nazione: w.nazione || 'Italia',
          prezzoCarta: w.prezzoCarta || '', formato: w.formato || ''
        });
      });
    }
    scheduleSave();
    notify(`📋 Bozze offline: ${Object.keys(byDist).length} distrib., vai in Ordini`);
    exitSel();
    if (section === 'ordini') render();
  }
}

// ─── SHORTCUTS MODAL ─────────────────────────────────────────────────────────
function openShortcutsModal(){
  const sections = [
    {
      label: 'Globali',
      icon: '🌐',
      rows: [
        ['Esc', 'Chiude qualsiasi modal aperto'],
      ]
    },
    {
      label: 'Inventario',
      icon: '🍷',
      note: 'Solo fuori dai campi di testo',
      rows: [
        ['↑ ↓', 'Naviga riga per riga, scrolla automaticamente'],
        ['Space', 'Toggle checkbox riga selezionata (modalità multipla)'],
        ['/', 'Focus sulla barra di ricerca'],
        ['N', 'Nuovo vino'],
        ['E', 'Modifica vino selezionato'],
        ['P', 'Nota veloce sul vino selezionato'],
        ['Del / ⌫', 'Elimina vino selezionato'],
      ]
    },
    {
      label: 'Movimenti',
      icon: '📦',
      rows: [
        ['Ctrl + Enter', 'Registra carico / scarico'],
      ]
    },
  ];

  const html = sections.map(s => `
    <div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:13px">${s.icon}</span>
        <span style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--txt3)">${s.label}</span>
        ${s.note ? `<span style="font-size:10px;color:var(--txt4);font-style:italic">— ${s.note}</span>` : ''}
        <div style="flex:1;height:1px;background:var(--border)"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${s.rows.map(([k,d]) => `
        <div style="display:flex;align-items:center;gap:12px;padding:6px 10px;border-radius:var(--radius-sm);background:rgba(58,58,60,.3)">
          <kbd style="display:inline-flex;align-items:center;justify-content:center;min-width:80px;padding:3px 10px;background:var(--bg3);border:1px solid var(--border2);border-bottom:2px solid var(--border2);border-radius:6px;font-family:'Montserrat',monospace;font-size:11px;font-weight:600;color:var(--txt2);white-space:nowrap;flex-shrink:0">${k}</kbd>
          <span style="font-size:12px;color:var(--txt2)">${d}</span>
        </div>`).join('')}
      </div>
    </div>
  `).join('');

  document.getElementById('shortcuts-modal-body').innerHTML = html;
  document.getElementById('shortcuts-modal-backdrop').classList.remove('hidden');
}

function closeShortcutsModal(e){
  if(e && e.target !== document.getElementById('shortcuts-modal-backdrop')) return;
  document.getElementById('shortcuts-modal-backdrop').classList.add('hidden');
}

// ─── KEYBOARD SHORTCUTS GLOBALI ───────────────────────────────────────────────
// Escape → chiude qualsiasi modal aperto
// /      → focus ricerca inventario (solo se sezione inventario)
// N      → apre modal Aggiungi Vino (solo se sezione inventario, fuori da input)
document.addEventListener('keydown', function(e){
  // Escape: chiude modal aperto — funziona sempre, anche dentro input
  if(e.key === 'Escape'){
    const modals = [
      'wine-modal-backdrop','bulk-modal-backdrop','dup-modal-backdrop',
      'note-veloce-backdrop','db-config-backdrop','shortcuts-modal-backdrop'
    ];
    let closed = false;
    modals.forEach(id => {
      const el = document.getElementById(id);
      if(el && !el.classList.contains('hidden')){ el.classList.add('hidden'); closed = true; }
    });
    // chiude anche modal dinamici iniettati da renderMovimenti / renderOrdini
    ['mov-edit-backdrop','ordine-modal-backdrop','ricezione-modal-backdrop','ordine-evaso-modal-backdrop'].forEach(id => {
      const el = document.getElementById(id);
      if(el && !el.classList.contains('hidden')){ el.classList.add('hidden'); closed = true; }
    });
    if(closed) return;
  }

  // Shortcut solo se loggato e fuori da campi di testo
  if(!sessionStorage.getItem('cm_logged')) return;
  if(e.target.matches('input,select,textarea')) return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;

  // Ctrl+Enter → conferma form Movimenti (registra carico/scarico)
  if((e.key === 'Enter') && (e.ctrlKey || e.metaKey) && section === 'movimenti'){
    e.preventDefault();
    registraMovimento();
    return;
  }

  // / → focus barra di ricerca inventario
  if(e.key === '/' && section === 'inventario'){
    e.preventDefault();
    const inv = document.getElementById('inv-search');
    if(inv){ inv.focus(); inv.select(); }
    return;
  }
  // N → nuovo vino (solo inventario, modal non aperto)
  if((e.key === 'n' || e.key === 'N') && section === 'inventario'){
    const anyOpen = ['wine-modal-backdrop','bulk-modal-backdrop'].some(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
    if(!anyOpen) openWineModal(null);
    return;
  }
  // E → modifica vino selezionato (inventario)
  if((e.key === 'e' || e.key === 'E') && section === 'inventario'){
    if(_selectedWineId){ openWineModal(_selectedWineId); }
    return;
  }
  // P → nota veloce su vino selezionato (inventario)
  if((e.key === 'p' || e.key === 'P') && section === 'inventario'){
    if(_selectedWineId){ openNoteVeloce(_selectedWineId); }
    return;
  }
  // Delete / Backspace → elimina vino selezionato (inventario)
  if((e.key === 'Delete' || e.key === 'Backspace') && section === 'inventario'){
    if(_selectedWineId){ deleteWine(_selectedWineId); }
    return;
  }
  // ArrowDown / ArrowUp → naviga le righe inventario con tastiera
  if((e.key === 'ArrowDown' || e.key === 'ArrowUp') && section === 'inventario'){
    e.preventDefault();
    const ids = _selAllIds.length ? _selAllIds
      : [...document.querySelectorAll('.inv-table tr[data-wine-id]')].map(r=>r.dataset.wineId);
    if(!ids.length) return;
    const cur = ids.indexOf(_selectedWineId);
    const next = e.key === 'ArrowDown'
      ? (cur < 0 ? 0 : Math.min(cur+1, ids.length-1))
      : (cur < 0 ? ids.length-1 : Math.max(cur-1, 0));
    selectWineRow(ids[next]);
    // scroll morbido alla riga
    const row = document.querySelector(`.inv-table tr[data-wine-id="${ids[next]}"]`);
    if(row) row.scrollIntoView({block:'nearest',behavior:'smooth'});
    return;
  }
  // Space → toggle checkbox selezione multipla sulla riga focalizzata (non hover)
  if(e.key === ' ' && section === 'inventario' && selMode === 'wines' && _selectedWineId){
    e.preventDefault();
    toggleSel(_selectedWineId);
    _updateBulkBar();
    return;
  }
});
