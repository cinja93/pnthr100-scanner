// S&P 400 Mid-Cap stocks exclusive to the speculative universe
// (not in S&P 500, Nasdaq 100, or Dow 30)
// 80 Long Leaders: above 21-week EMA, price >= $20, sorted by 52-week return desc
// 71 Short Leaders: below 21-week EMA, price >= $70, sorted by 52-week return asc
// Last refreshed: 2026-04-13

export const SPEC_LONGS = [
  "TTMI","ARWR","AEIS","MKSI","VICR","AMKR","FN","ATI","CAR","SITM",
  "FIVE","STRL","AA","MTZ","VAL","NXT","FTI","ROIV","DOCN","ELAN",
  "PBF","MTSI","NVT","LSCC","CRS","DY","LFUS","FLEX","RMBS","IPGP",
  "SLAB","ENS","WWD","CW","CGNX","ONTO","BWXT","WFRD","XPO","RRX",
  "ALGM","BWA","FLS","UTHR","WCC","ST","DAR","DINO","ENTG","APG",
  "JAZZ","SNX","CRUS","EVR","IDCC","RBC","TEX","TNL","AMG","MUR",
  "OSK","SOLS","LIVN","BC","NVST","TKR","PR","MLI","ITT","SPXC",
  "JHG","FCFS","OVV","GXO","CYTK","GTLS","ORA","AHR","HXL","NYT",
];

export const SPEC_SHORTS = [
  "DUOL","SFM","PCTY","CVLT","MORN","GWRE","QLYS","APPF","CHE","HLNE",
  "BAH","KNSL","MANH","PLNT","MZTI","RH","BJ","SAIC","OLLI","WING",
  "OC","OLED","CHDN","POST","INGR","ACM","LPX","SIGI","ESAB","UFPI",
  "EXP","HQY","MTN","RGEN","LAD","LOPE","HLI","CSL","TXRH","AFG",
  "PAG","SEIC","NEU","MIDD","THO","WAL","PFGC","BIO","SSD","MSA",
  "BCO","AYI","AVAV","NXST","NBIX","CACI","ALV","SGI","VC","SF",
  "BLD","TWLO","WMS","DCI","TOL","SYNA","TLN","THC","MEDP","ILMN","KTOS",
];
