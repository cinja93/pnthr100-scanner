// S&P 400 Mid-Cap stocks exclusive to the speculative universe
// (not in S&P 500, Nasdaq 100, or Dow 30)
// 81 Long Leaders: above 50-week EMA, price > $20, sorted by weighted alpha desc
// 81 Short Leaders: below 50-week EMA, price > $70, sorted by weighted alpha asc

export const SPEC_LONGS = [
  "LITE","COHR","ROIV","ATI","VAL","AEIS","TTMI","FTI","SATS","MTZ",
  "MKSI","COKE","CRS","AA","NXT","SLAB","FN","WWD","FIVE","ARWR",
  "STRL","DAR","XPO","RGLD","MTSI","IPGP","CW","RBC","PBF","UTHR",
  "LSCC","FCFS","RRX","JAZZ","CASY","THC","OVV","AMKR","AHR","NYT",
  "ENS","KTOS","CGNX","NXST","DTM","ONTO","ENSG","BWA","DY","HXL",
  "FLS","TKR","LFUS","WFRD","TTC","LNTH","TEX","WLK","ENTG","CLH",
  "OSK","NVST","MP","USFD","CYTK","PEN","BWXT","MTDR","APG",
  "NVT","CHRD","KEX","OHI","CNX","ULS","WBS","WCC","KNX","WTS","NJR",
];

export const SPEC_SHORTS = [
  "DUOL","CVLT","RH","OLED","QLYS","SFM","PCTY","CAR","HLNE","PLNT",
  "BAH","MORN","MANH","WING","OC","CHDN","ELF","APPF","HLI","LAD",
  "GWRE","THO","RGEN","EEFT","CHE","ACM","AYI","KNSL","EXP","AVAV",
  "CHH","SAIC","HQY","WAL","TRU","LPX","PNFP","OKTA","ANF","MMS",
  "CROX","MTN","VC","RPM","UFPI","NEU","ESAB","WH","BIO","SIGI",
  "OLLI","LOPE","PAG","BLD","DKS","INGR","WSO","ALV","EXPO","PFGC",
  "EVR","FCN","SF","AN","NBIX","LANC","PRI","ATR","SEIC","AFG",
  "UNM","SSB","CSL","TXRH","POST","EHC","SGI","MEDP","UMBF","AAON","JLL",
];
