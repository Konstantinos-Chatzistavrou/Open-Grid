// Photorealistic 2048x2048 CanvasTexture atlas for Times Square LED megascreens & NYC storefront signage.
// Layout (UV y=1 is top of canvas with flipY=true):
//   Rows 0..3 (top 1536 px, 4 rows x 2 cols of 1024x384 px each): 8 Times Square LED mega-billboards (kinds 0..7)
//   Rows 4..5 (bottom 512 px, 4 rows x 2 cols of 1024x128 px each): 8 NYC street-level storefront & neon signs (kinds 0..7)
import * as THREE from 'three/webgpu';

let cachedAtlas: THREE.CanvasTexture | null = null;

// ---- texts: per city (setSignCity, called by main.ts before the atlas is drawn). No real brand, venue chain, newspaper,
// index or ticker: every name here is made up (CREDITS.md: de-branded city).
type SignTexts = typeof NYC_TEXT;
const NYC_TEXT = {
  perfNo: "N° 9",
  perfTop: "FIFTH AVENUE FLAGSHIP · PARIS · NEW YORK",
  perfName: "L’OR DE NUIT",
  perfSub: "EAU DE PARFUM INTENSE",
  perfAddr: "MAISON VALENTIN · 700 FIFTH AVE",
  showTop: "★ WINNER OF 9 STAGE AWARDS · MERIDIAN THEATRE · W 45TH ST ★",
  showName: "EMPIRE OF LIGHTS",
  showQuote: "“THE MOST ELECTRIFYING NIGHT ON BROADWAY” — THE EVENING CHRONICLE",
  showTime: "TONIGHT AT 8:00 PM · TICKETS AT BOX OFFICE",
  mktTop: "TIMES SQUARE MARKET WALL // GLOBAL INDICES LIVE",
  mktRibbon: "▲ ORBX 448.10 (+1.4%)   ▲ HLCN 212.40 (+2.1%)   ▲ QNTA 189.30 (+1.7%)   ▲ VRTX 612.00 (+2.9%)",
  techTop: "FIFTH AVENUE FLAGSHIP · NEW YORK",
  sodaSub: "ICE COLD · ZERO SUGAR · TIMES SQUARE EDITION",
  gpTop: "GT WORLD STREET SERIES · NEW YORK",
  gpCircuit: "7TH AVE · BROADWAY · 5TH AVE · 34TH ST CIRCUIT",
  newsCam: "MANHATTAN SKYLINE CAM · MIDTOWN WEST 54°F",
  newsHead: "MIDTOWN NIGHT GRAND PRIX",
  newsSub: "SEVENTH AVENUE & TIMES SQUARE CORRIDOR CLOSED FOR STREET CIRCUIT",
  newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED SEVENTH AVENUE",
  newsTransit: "TRANSIT: 1/2/3 N/Q/R/W ON TIME · FDR DRIVE CLEAR · WEATHER: LIGHT RAIN ENDING · 54°F",
  filmTop: "FILMED IN 70MM · GRAND CINEMAS 42ND STREET",
  filmName: "REDLINE MANHATTAN",
  filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE MANHATTAN\" · SOUNDTRACK IN IMMERSIVE SOUND",
  idx1: "GRID 100",
  idx2: "MTR 500",
  shops: [["CITY CARE · PHARMACY", "24 HOUR PRESCRIPTIONS · MARKET"], ["BROADWAY ARTISAN PIZZA", "COAL FIRED BRICK OVEN · EST. 1964"], ["MIDTOWN GOURMET DELI", "HOT GRILL · SANDWICHES · COFFEE 24HR"], ["METRO NATIONAL BANK", "24H ATM · PRIVATE CLIENT · VAULT"], ["VARENNE & CO. HOROLOGY", "FINE SWISS TIMEPIECES · FIFTH AVE"], ["MERIDIAN LOUNGE & BAR", "LIVE JAZZ · COCKTAILS · LATE KITCHEN"], ["BLUE HOUR ESPRESSO", "SINGLE ORIGIN ROASTERS · BAKERY"], ["TIMES SQUARE ELECTRONICS", "CAMERAS · AUDIO · LENSES · DUTY FREE"]],
};
const CITY_TEXT: Record<string, Partial<SignTexts>> = {
  london: {
    perfTop: "BOND STREET FLAGSHIP · PARIS · LONDON",
    perfAddr: "MAISON VALENTIN · NEW BOND STREET",
    showTop: "★ WINNER OF 7 STAGE AWARDS · REGENT THEATRE · SHAFTESBURY AVE ★",
    showQuote: "“THE WEST END’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT AT 7:30 PM · TICKETS AT BOX OFFICE",
    mktTop: "CITY OF LONDON // GLOBAL INDICES LIVE",
    techTop: "REGENT STREET FLAGSHIP · LONDON",
    sodaSub: "ICE COLD · ZERO SUGAR · PICCADILLY EDITION",
    gpTop: "GT WORLD STREET SERIES · LONDON",
    gpCircuit: "PICCADILLY · STRAND · PALL MALL · WHITEHALL CIRCUIT",
    newsCam: "WEST END SKYLINE CAM · TRAFALGAR 9°C",
    newsHead: "WEST END NIGHT GRAND PRIX",
    newsSub: "PICCADILLY & STRAND CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED PICCADILLY",
    newsTransit: "UNDERGROUND: GOOD SERVICE · EMBANKMENT CLEAR · WEATHER: DRIZZLE · 9°C",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS LEICESTER SQUARE",
    filmName: "REDLINE LONDON",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE LONDON\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "CITY 100",
    idx2: "LDN 250",
    shops: [["STRAND CHEMIST", "PRESCRIPTIONS · HEALTH & BEAUTY"], ["SOHO WOOD-FIRED PIZZA", "NEAPOLITAN · EST. 1972"], ["THE CROWN & ANCHOR", "FREE HOUSE · REAL ALES · SUNDAY ROAST"], ["METRO NATIONAL BANK", "24H CASH · PRIVATE CLIENT"], ["VARENNE & CO. HOROLOGY", "FINE SWISS TIMEPIECES · BURLINGTON ARCADE"], ["MERIDIAN COCKTAIL BAR", "LIVE JAZZ · LATE LICENCE"], ["BLUE HOUR ESPRESSO", "SPECIALITY COFFEE · BAKERY"], ["WEST END ELECTRONICS", "CAMERAS · AUDIO · REPAIRS"]],
  },
  paris: {
    perfTop: "AVENUE MONTAIGNE · PARIS",
    perfAddr: "MAISON VALENTIN · RUE DU FAUBOURG",
    showTop: "★ LE SPECTACLE DE L’ANNÉE · THÉÂTRE MERIDIEN · BD HAUSSMANN ★",
    showName: "EMPIRE DES LUMIÈRES",
    showQuote: "« LA NUIT LA PLUS ÉLECTRIQUE DE PARIS » — LE COURRIER DU SOIR",
    showTime: "CE SOIR 20H30 · BILLETTERIE SUR PLACE",
    mktTop: "PARIS LA BOURSE // INDICES MONDIAUX EN DIRECT",
    techTop: "BOUTIQUE CHAMPS-ÉLYSÉES · PARIS",
    sodaSub: "GLACÉ · ZÉRO SUCRE · ÉDITION CONCORDE",
    gpTop: "GT WORLD STREET SERIES · PARIS",
    gpCircuit: "CHAMPS-ÉLYSÉES · CONCORDE · RIVOLI · QUAIS",
    newsCam: "CAMÉRA TOUR · CONCORDE 8°C",
    newsHead: "GRAND PRIX DE NUIT DE PARIS",
    newsSub: "CHAMPS-ÉLYSÉES ET RUE DE RIVOLI FERMÉS POUR LE CIRCUIT",
    newsBreak: "FLASH INFO   RECORDS DU TOUR SOUS LA PLUIE SUR LES CHAMPS-ÉLYSÉES",
    newsTransit: "MÉTRO : TRAFIC NORMAL · VOIES SUR BERGE DÉGAGÉES · MÉTÉO : AVERSES · 8°C",
    filmTop: "TOURNÉ EN 70MM · GRAND CINÉMA DES BOULEVARDS",
    filmName: "LIGNE ROUGE PARIS",
    filmCredits: "METRO PICTURES PRÉSENTE UNE PRODUCTION NIGHT RUN « LIGNE ROUGE PARIS » · EN SON IMMERSIF",
    idx1: "SEINE 40",
    idx2: "EUR 600",
    shops: [["PHARMACIE DU LOUVRE", "OUVERT 24H/24 · PARAPHARMACIE"], ["BOULANGERIE SAINT-HONORÉ", "PAIN AU LEVAIN · VIENNOISERIES"], ["BRASSERIE DE LA CONCORDE", "FRUITS DE MER · OUVERT TARD"], ["BANQUE NATIONALE DU CENTRE", "DISTRIBUTEUR 24H · CONSEIL PRIVÉ"], ["VARENNE & CIE HORLOGERIE", "MONTRES SUISSES · PLACE VENDÔME"], ["CAFÉ DE LA SEINE", "BAR · TERRASSE · CONCERTS JAZZ"], ["L’HEURE BLEUE CAFÉ", "TORRÉFACTEUR · PÂTISSERIE"], ["RIVOLI ÉLECTRONIQUE", "PHOTO · AUDIO · DÉTAXE"]],
  },
  tokyo: {
    perfTop: "GINZA FLAGSHIP · PARIS · TOKYO",
    perfAddr: "MAISON VALENTIN · OMOTESANDO",
    showTop: "★ SHIBUYA STAGE AWARDS 7 WINS · MERIDIAN HALL ★",
    showQuote: "“TOKYO’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 19:00 · TICKETS AT THE BOX OFFICE",
    mktTop: "SHIBUYA MARKET WALL // GLOBAL INDICES LIVE",
    techTop: "OMOTESANDO FLAGSHIP · TOKYO",
    sodaSub: "ICE COLD · ZERO SUGAR · SHIBUYA EDITION",
    gpTop: "GT WORLD STREET SERIES · TOKYO",
    gpCircuit: "SHIBUYA · OMOTESANDO · MEIJI-DORI · SHINJUKU",
    newsCam: "SHIBUYA SCRAMBLE CAM · 12°C",
    newsHead: "SHIBUYA NIGHT GRAND PRIX",
    newsSub: "MEIJI-DORI & OMOTESANDO CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED MEIJI-DORI",
    newsTransit: "TRAINS: ALL LINES ON TIME · YAMATE-DORI CLEAR · WEATHER: LIGHT RAIN · 12°C",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS SHINJUKU",
    filmName: "REDLINE TOKYO",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE TOKYO\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "SBY 225",
    idx2: "PAC 500",
    shops: [["SHIBUYA DRUGSTORE", "COSMETICS · MEDICINE · OPEN LATE"], ["RAMEN YOKOCHO", "TONKOTSU · SHOYU · OPEN 24H"], ["IZAKAYA NIGHT OWL", "YAKITORI · SAKE · HIGHBALL"], ["METRO TRUST BANK", "ATM 24H · FOREIGN EXCHANGE"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES · GINZA"], ["KARAOKE STAR", "PRIVATE ROOMS · ALL NIGHT"], ["BLUE HOUR COFFEE", "HAND DRIP · BAKERY"], ["SHINJUKU ELECTRONICS", "CAMERAS · GAMES · TAX FREE"]],
  },
  losangeles: {
    perfTop: "RODEO FLAGSHIP · PARIS · LOS ANGELES",
    perfAddr: "MAISON VALENTIN · 7TH STREET",
    showTop: "★ WINNER OF 9 STAGE AWARDS · MERIDIAN THEATRE · BROADWAY DTLA ★",
    showQuote: "“THE MOST ELECTRIFYING NIGHT IN DOWNTOWN” — THE EVENING CHRONICLE",
    mktTop: "FINANCIAL DISTRICT // GLOBAL INDICES LIVE",
    techTop: "GRAND AVENUE FLAGSHIP · LOS ANGELES",
    sodaSub: "ICE COLD · ZERO SUGAR · DOWNTOWN EDITION",
    gpTop: "GT WORLD STREET SERIES · LOS ANGELES",
    gpCircuit: "BROADWAY · GRAND AVE · FIGUEROA · 1ST ST CIRCUIT",
    newsCam: "DOWNTOWN SKYLINE CAM · BUNKER HILL 61°F",
    newsHead: "DOWNTOWN NIGHT GRAND PRIX",
    newsSub: "FIGUEROA & GRAND AVENUE CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED FIGUEROA",
    newsTransit: "TRANSIT: METRO ON TIME · 110 & 101 CLEAR · WEATHER: RARE RAIN · 61°F",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS BROADWAY",
    filmName: "REDLINE LOS ANGELES",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE LOS ANGELES\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "PAC 100",
    idx2: "MTR 500",
    shops: [["CITY CARE · PHARMACY", "24 HOUR PRESCRIPTIONS · MARKET"], ["TACOS EL GRAND 24HR", "AL PASTOR · CARNE ASADA · HORCHATA"], ["BROADWAY DELI & GRILL", "BREAKFAST ALL DAY · EST. 1948"], ["METRO NATIONAL BANK", "24H ATM · PRIVATE CLIENT"], ["VARENNE & CO. HOROLOGY", "FINE SWISS TIMEPIECES · 7TH ST"], ["MERIDIAN ROOFTOP BAR", "COCKTAILS · DJ · SKYLINE VIEWS"], ["BLUE HOUR ESPRESSO", "COLD BREW · BAKERY"], ["DOWNTOWN ELECTRONICS", "CAMERAS · AUDIO · REPAIRS"]],
  },
  barcelona: {
    perfTop: "PASSEIG DE GRÀCIA · PARIS · BARCELONA",
    perfAddr: "MAISON VALENTIN · PASSEIG DE GRÀCIA",
    showTop: "★ TEATRE MERIDIÀ · PARAL·LEL ★",
    showQuote: "«LA NIT MÉS ELÈCTRICA DE BARCELONA» — EL CORREU DEL VESPRE",
    showTime: "AQUESTA NIT 21:00 · TAQUILLA OBERTA",
    mktTop: "BARCELONA BORSA // ÍNDEXS MUNDIALS EN DIRECTE",
    techTop: "PASSEIG DE GRÀCIA FLAGSHIP · BARCELONA",
    sodaSub: "GEL · ZERO SUCRE · EDICIÓ RAMBLES",
    gpTop: "GT WORLD STREET SERIES · BARCELONA",
    gpCircuit: "PASSEIG DE GRÀCIA · DIAGONAL · GRAN VIA · RAMBLES",
    newsCam: "CÀMERA PLAÇA DE CATALUNYA · 14°C",
    newsHead: "GRAN PREMI NOCTURN DE BARCELONA",
    newsSub: "PASSEIG DE GRÀCIA I GRAN VIA TALLATS PEL CIRCUIT",
    newsBreak: "ÚLTIMA HORA   RÈCORDS DE VOLTA SOTA LA PLUJA A LA DIAGONAL",
    newsTransit: "METRO: SERVEI NORMAL · RONDES SENSE RETENCIONS · TEMPS: PLUGIM · 14°C",
    filmTop: "FILMED IN 70MM · CINEMES GRAN VIA · 70MM",
    filmName: "REDLINE BARCELONA",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE BARCELONA\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "BCN 35",
    idx2: "IBX 100",
    shops: [["FARMÀCIA DEL PASSEIG", "OBERTA 24 HORES"], ["TAPES I VERMUT", "CERVESERIA · DES DE 1957"], ["FORN DE PA SANT JORDI", "PA · PASTISSERIA"], ["BANC MEDITERRANI", "CAIXER 24H"], ["RELLOTGERIA VARENNE", "RELLOTGES SUÏSSOS"], ["BAR LA NIT", "CÒCTELS · MÚSICA"], ["CAFÈ BLAU", "ESPRESSO · ESMORZARS"], ["ELECTRÒNICA GRÀCIA", "MÒBILS · ACCESSORIS"]],
  },
  madrid: {
    perfTop: "CALLE SERRANO · PARIS · MADRID",
    perfAddr: "MAISON VALENTIN · CALLE SERRANO",
    showTop: "★ TEATRO MERIDIANO · GRAN VÍA ★",
    showQuote: "«LA NOCHE MÁS ELÉCTRICA DE MADRID» — EL CORREO DE LA TARDE",
    showTime: "ESTA NOCHE 20:30 · TAQUILLA ABIERTA",
    mktTop: "BOLSA DE MADRID // ÍNDICES MUNDIALES EN DIRECTO",
    techTop: "CALLE SERRANO FLAGSHIP · MADRID",
    sodaSub: "HELADO · CERO AZÚCAR · EDICIÓN CALLAO",
    gpTop: "GT WORLD STREET SERIES · MADRID",
    gpCircuit: "GRAN VÍA · ALCALÁ · CIBELES · CASTELLANA",
    newsCam: "CÁMARA PUERTA DEL SOL · 11°C",
    newsHead: "GRAN PREMIO NOCTURNO DE MADRID",
    newsSub: "GRAN VÍA Y ALCALÁ CERRADAS POR EL CIRCUITO",
    newsBreak: "ÚLTIMA HORA   RÉCORDS DE VUELTA BAJO LA LLUVIA EN LA GRAN VÍA",
    newsTransit: "METRO: SERVICIO NORMAL · M-30 SIN RETENCIONES · TIEMPO: LLOVIZNA · 11°C",
    filmTop: "FILMED IN 70MM · CINES CALLAO · 70MM",
    filmName: "REDLINE MADRID",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE MADRID\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "MAD 35",
    idx2: "IBX 100",
    shops: [["FARMACIA DE GUARDIA", "ABIERTO 24 HORAS"], ["TABERNA EL GATO", "TAPAS · VERMUT · DESDE 1951"], ["CHURRERÍA SAN GINÉS", "CHOCOLATE CON CHURROS"], ["BANCO CASTELLANO", "CAJERO 24H"], ["RELOJERÍA VARENNE", "RELOJES SUIZOS"], ["CERVECERÍA LA NOCHE", "CAÑAS · RACIONES"], ["CAFÉ AZUL", "ESPRESSO · DESAYUNOS"], ["ELECTRÓNICA SOL", "MÓVILES · ACCESORIOS"]],
  },
  lisbon: {
    perfTop: "AVENIDA DA LIBERDADE · PARIS · LISBOA",
    perfAddr: "MAISON VALENTIN · AVENIDA DA LIBERDADE",
    showTop: "★ TEATRO MERIDIANO · CHIADO ★",
    showQuote: "«A NOITE MAIS ELÉTRICA DE LISBOA» — O CORREIO DA TARDE",
    showTime: "ESTA NOITE 21:00 · BILHETEIRA ABERTA",
    mktTop: "BOLSA DE LISBOA // ÍNDICES MUNDIAIS AO VIVO",
    techTop: "AVENIDA DA LIBERDADE FLAGSHIP · LISBOA",
    sodaSub: "GELADO · ZERO AÇÚCAR · EDIÇÃO ROSSIO",
    gpTop: "GT WORLD STREET SERIES · LISBOA",
    gpCircuit: "BAIXA · CHIADO · RUA DA PRATA · RIBEIRA",
    newsCam: "CÂMARA PRAÇA DO COMÉRCIO · 15°C",
    newsHead: "GRANDE PRÉMIO NOTURNO DE LISBOA",
    newsSub: "BAIXA E CHIADO FECHADOS PARA O CIRCUITO",
    newsBreak: "ÚLTIMA HORA   RECORDES DE VOLTA À CHUVA NA RUA AUGUSTA",
    newsTransit: "METRO: CIRCULAÇÃO NORMAL · ELÉTRICO 28 A HORAS · TEMPO: CHUVISCO · 15°C",
    filmTop: "FILMED IN 70MM · CINEMA TIVOLI · 70MM",
    filmName: "REDLINE LISBOA",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE LISBOA\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "LSB 20",
    idx2: "PSI 100",
    shops: [["FARMÁCIA DO ROSSIO", "SERVIÇO PERMANENTE"], ["TASCA DO FADO", "PETISCOS · VINHO VERDE"], ["PASTELARIA BELÉM NOVA", "PASTÉIS DE NATA"], ["BANCO ATLÂNTICO", "MULTIBANCO 24H"], ["RELOJOARIA VARENNE", "RELÓGIOS SUÍÇOS"], ["GINJINHA DA BAIXA", "DESDE 1840"], ["CAFÉ AZULEJO", "BICA · TORRADAS"], ["ELETRÓNICA CHIADO", "TELEMÓVEIS"]],
  },
  crete: {
    shops: [["ΤΑΒΕΡΝΑ ΣΦΑΚΙΑ", "ΚΡΗΤΙΚΗ ΚΟΥΖΙΝΑ"], ["ΚΑΦΕΝΕΙΟ ΙΜΠΡΟΣ", "ΚΑΦΕΣ · ΤΣΙΚΟΥΔΙΑ"], ["ΦΟΥΡΝΟΣ ΛΕΥΚΑ ΟΡΗ", "ΠΑΞΙΜΑΔΙΑ · ΑΡΤΟΣ"], ["ΠΑΝΤΟΠΩΛΕΙΟ ΚΟΜΗΤΑΔΕΣ", "ΤΟΠΙΚΑ ΠΡΟΪΟΝΤΑ"], ["ΦΑΡΜΑΚΕΙΟ ΧΩΡΑΣ", "ΔΙΗΜΕΡΕΥΟΝ"], ["ΤΑΒΕΡΝΑ ΛΙΜΑΝΙ", "ΦΡΕΣΚΑ ΨΑΡΙΑ"], ["ΚΑΦΕ ΛΙΒΥΚΟ", "ΕΣΠΡΕΣΟ · ΠΑΓΩΤΑ"], ["ΕΡΓΑΣΤΗΡΙΟ ΚΕΡΑΜΙΚΗΣ", "ΧΕΙΡΟΠΟΙΗΤΑ"]],
  },
  berlin: {
    perfTop: "KURFÜRSTENDAMM · PARIS · BERLIN",
    perfAddr: "MAISON VALENTIN · KURFÜRSTENDAMM",
    showTop: "★ MERIDIAN THEATER · FRIEDRICHSTRASSE ★",
    showQuote: "„BERLINS ELEKTRISIERENDSTE NACHT“ — DER ABENDKURIER",
    showTime: "HEUTE 20:00 · KASSE GEÖFFNET",
    mktTop: "BÖRSE BERLIN // WELTINDIZES LIVE",
    techTop: "KURFÜRSTENDAMM FLAGSHIP · BERLIN",
    sodaSub: "EISKALT · OHNE ZUCKER · ALEX EDITION",
    gpTop: "GT WORLD STREET SERIES · BERLIN",
    gpCircuit: "UNTER DEN LINDEN · FRIEDRICHSTRASSE · ALEXANDERPLATZ",
    newsCam: "KAMERA FERNSEHTURM · 6°C",
    newsHead: "NACHT-GRAND-PRIX BERLIN",
    newsSub: "UNTER DEN LINDEN UND FRIEDRICHSTRASSE FÜR DEN STRECKENKURS GESPERRT",
    newsBreak: "EILMELDUNG   RUNDENREKORDE IM REGEN AUF DER KARL-MARX-ALLEE",
    newsTransit: "S-BAHN: PÜNKTLICH · STADTRING FREI · WETTER: NIESELREGEN · 6°C",
    filmTop: "FILMED IN 70MM · KINO AM ZOO · 70MM",
    filmName: "REDLINE BERLIN",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE BERLIN\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "BRL 40",
    idx2: "DAX-N 160",
    shops: [["APOTHEKE AM PLATZ", "NOTDIENST 24 STUNDEN"], ["CURRYWURST ECKE", "SEIT 1961"], ["BÄCKEREI SCHNEIDER", "BROT · KUCHEN"], ["SPREE BANK", "GELDAUTOMAT 24H"], ["UHREN VARENNE", "SCHWEIZER UHREN"], ["SPÄTI 24/7", "GETRÄNKE · SNACKS"], ["KAFFEEBAR BLAU", "ESPRESSO · FRÜHSTÜCK"], ["ELEKTRO MITTE", "HANDYS · ZUBEHÖR"]],
  },
  amsterdam: {
    perfTop: "PC HOOFTSTRAAT · PARIS · AMSTERDAM",
    perfAddr: "MAISON VALENTIN · PC HOOFTSTRAAT",
    showTop: "★ MERIDIAAN THEATER · LEIDSEPLEIN ★",
    showQuote: "„DE MEEST ELEKTRISCHE NACHT VAN AMSTERDAM“ — DE AVONDKOERIER",
    showTime: "VANAVOND 20:15 · KASSA OPEN",
    mktTop: "BEURS AMSTERDAM // WERELDINDEXEN LIVE",
    techTop: "PC HOOFTSTRAAT FLAGSHIP · AMSTERDAM",
    sodaSub: "IJSKOUD · ZONDER SUIKER · DAM EDITIE",
    gpTop: "GT WORLD STREET SERIES · AMSTERDAM",
    gpCircuit: "DAMRAK · ROKIN · HERENGRACHT · LEIDSEPLEIN",
    newsCam: "CAMERA DAM · 7°C",
    newsHead: "NACHTGRANDPRIX AMSTERDAM",
    newsSub: "DAMRAK EN ROKIN AFGESLOTEN VOOR HET STRATENCIRCUIT",
    newsBreak: "BREKEND NIEUWS   RONDERECORDS IN DE REGEN LANGS DE GRACHTEN",
    newsTransit: "TRAM: REGULIERE DIENST · RING A10 VRIJ · WEER: MOTREGEN · 7°C",
    filmTop: "FILMED IN 70MM · BIOSCOOP TUSCHINSKI-ZAAL · 70MM",
    filmName: "REDLINE AMSTERDAM",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE AMSTERDAM\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "AMS 25",
    idx2: "AEX-N 100",
    shops: [["APOTHEEK CENTRUM", "24 UUR GEOPEND"], ["FRIETWINKEL DE GRACHT", "VERS GESNEDEN"], ["BAKKERIJ VAN DAM", "STROOPWAFELS"], ["GRACHTEN BANK", "GELDAUTOMAAT 24U"], ["HORLOGES VARENNE", "ZWITSERSE HORLOGES"], ["BRUIN CAFÉ DE NACHT", "BIER · BITTERBALLEN"], ["KOFFIEBAR BLAUW", "ESPRESSO · ONTBIJT"], ["ELEKTRO DAMRAK", "TELEFOONS"]],
  },
  seoul: {
    perfTop: "GANGNAM-DAERO · PARIS · SEOUL",
    perfAddr: "MAISON VALENTIN · GANGNAM-DAERO",
    showTop: "★ MERIDIAN HALL · MYEONGDONG ★",
    showQuote: "“SEOUL’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 19:30 · TICKETS AT THE BOX OFFICE",
    mktTop: "YEOUIDO MARKET WALL // GLOBAL INDICES LIVE",
    techTop: "GANGNAM-DAERO FLAGSHIP · SEOUL",
    sodaSub: "ICE COLD · ZERO SUGAR · MYEONGDONG EDITION",
    gpTop: "GT WORLD STREET SERIES · SEOUL",
    gpCircuit: "SEJONG-DAERO · JONGNO · EULJI-RO · NAMDAEMUN",
    newsCam: "NAMSAN TOWER CAM · 9°C",
    newsHead: "SEOUL NIGHT GRAND PRIX",
    newsSub: "SEJONG-DAERO & JONGNO CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED JONGNO",
    newsTransit: "SUBWAY: ALL LINES ON TIME · OLYMPIC-DAERO CLEAR · WEATHER: LIGHT RAIN · 9°C",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS JONGNO · 70MM",
    filmName: "REDLINE SEOUL",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE SEOUL\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "KSP 200",
    idx2: "PAC 500",
    shops: [["JONGNO PHARMACY", "OPEN LATE · COSMETICS"], ["POCHA NIGHT MARKET", "TTEOKBOKKI · SOJU"], ["KOREAN BBQ HOUSE", "SAMGYEOPSAL · SINCE 1979"], ["HAN RIVER BANK", "ATM 24H"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES"], ["NORAEBANG STAR", "KARAOKE ROOMS · ALL NIGHT"], ["BLUE HOUR COFFEE", "HAND DRIP · BAKERY"], ["MYEONGDONG MOBILE", "PHONES · REPAIRS"]],
  },
  singapore: {
    perfTop: "ORCHARD ROAD · PARIS · SINGAPORE",
    perfAddr: "MAISON VALENTIN · ORCHARD ROAD",
    showTop: "★ MERIDIAN THEATRE · ESPLANADE ★",
    showQuote: "“SINGAPORE’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 8PM · TICKETS AT THE BOX OFFICE",
    mktTop: "RAFFLES PLACE // GLOBAL INDICES LIVE",
    techTop: "ORCHARD ROAD FLAGSHIP · SINGAPORE",
    sodaSub: "ICE COLD · ZERO SUGAR · MARINA EDITION",
    gpTop: "GT WORLD STREET SERIES · SINGAPORE",
    gpCircuit: "RAFFLES AVE · NICOLL HIGHWAY · ST ANDREW’S RD · MARINA",
    newsCam: "MARINA BAY CAM · 28°C",
    newsHead: "MARINA BAY NIGHT GRAND PRIX",
    newsSub: "RAFFLES AVENUE & ESPLANADE DRIVE CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED MARINA BAY",
    newsTransit: "MRT: ALL LINES NORMAL · ECP CLEAR · WEATHER: THUNDERY SHOWERS · 28°C",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS ORCHARD · 70MM",
    filmName: "REDLINE SINGAPORE",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE SINGAPORE\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "STI 30",
    idx2: "PAC 500",
    shops: [["CHINATOWN MEDICAL HALL", "TRADITIONAL · PHARMACY"], ["HAWKER CENTRE", "CHICKEN RICE · LAKSA · SATAY"], ["KOPITIAM 1965", "KOPI · KAYA TOAST"], ["STRAITS BANK", "ATM 24H"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES · ORCHARD"], ["ROOFTOP BAR MERIDIAN", "COCKTAILS · BAY VIEWS"], ["BLUE HOUR COFFEE", "ESPRESSO · BAKERY"], ["SIM LIM ELECTRONICS", "PHONES · GADGETS"]],
  },
  melbourne: {
    perfTop: "COLLINS STREET · PARIS · MELBOURNE",
    perfAddr: "MAISON VALENTIN · COLLINS STREET",
    showTop: "★ MERIDIAN THEATRE · EXHIBITION ST ★",
    showQuote: "“MELBOURNE’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 7:30PM · TICKETS AT THE BOX OFFICE",
    mktTop: "COLLINS STREET // GLOBAL INDICES LIVE",
    techTop: "COLLINS STREET FLAGSHIP · MELBOURNE",
    sodaSub: "ICE COLD · ZERO SUGAR · FLINDERS EDITION",
    gpTop: "GT WORLD STREET SERIES · MELBOURNE",
    gpCircuit: "SWANSTON · FLINDERS · SPENCER · LA TROBE",
    newsCam: "FEDERATION SQUARE CAM · 13°C",
    newsHead: "MELBOURNE NIGHT GRAND PRIX",
    newsSub: "SWANSTON & FLINDERS STREETS CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED FLINDERS STREET",
    newsTransit: "TRAMS: GOOD SERVICE · CITYLINK CLEAR · WEATHER: FOUR SEASONS IN ONE DAY · 13°C",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS BOURKE ST · 70MM",
    filmName: "REDLINE MELBOURNE",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE MELBOURNE\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "AUS 200",
    idx2: "PAC 500",
    shops: [["CITY CHEMIST", "OPEN LATE · PRESCRIPTIONS"], ["LANEWAY ESPRESSO", "FLAT WHITE · SINCE 1954"], ["DUMPLING HOUSE", "XIAO LONG BAO"], ["SOUTHERN CROSS BANK", "ATM 24H"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES"], ["ROOFTOP BAR", "COCKTAILS · CITY VIEWS"], ["PIE & MASH CORNER", "HOT PIES"], ["CBD MOBILE", "PHONES · REPAIRS"]],
  },
  toronto: {
    perfTop: "BLOOR STREET · PARIS · TORONTO",
    perfAddr: "MAISON VALENTIN · BLOOR STREET",
    showTop: "★ MERIDIAN THEATRE · KING STREET ★",
    showQuote: "“TORONTO’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 8PM · TICKETS AT THE BOX OFFICE",
    mktTop: "BAY STREET // GLOBAL INDICES LIVE",
    techTop: "BLOOR STREET FLAGSHIP · TORONTO",
    sodaSub: "ICE COLD · ZERO SUGAR · YONGE EDITION",
    gpTop: "GT WORLD STREET SERIES · TORONTO",
    gpCircuit: "YONGE · QUEEN · BAY · KING CIRCUIT",
    newsCam: "DUNDAS SQUARE CAM · 4°C",
    newsHead: "TORONTO NIGHT GRAND PRIX",
    newsSub: "YONGE & QUEEN STREETS CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED YONGE STREET",
    newsTransit: "SUBWAY: LINE 1 ON TIME · GARDINER CLEAR · WEATHER: SLEET · 4°C",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS YONGE · 70MM",
    filmName: "REDLINE TORONTO",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE TORONTO\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "TSX 60",
    idx2: "NA 500",
    shops: [["DOWNTOWN PHARMACY", "24 HOUR PRESCRIPTIONS"], ["PEAMEAL BACON DELI", "SINCE 1977"], ["POUTINE HOUSE", "OPEN LATE"], ["MAPLE TRUST BANK", "ATM 24H"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES · BLOOR"], ["QUEEN ST TAVERN", "CRAFT BEER · LIVE MUSIC"], ["BLUE HOUR COFFEE", "ESPRESSO · BAKERY"], ["YONGE ELECTRONICS", "PHONES · GADGETS"]],
  },
  chicago: {
    perfTop: "MICHIGAN AVENUE · PARIS · CHICAGO",
    perfAddr: "MAISON VALENTIN · MICHIGAN AVENUE",
    showTop: "★ MERIDIAN THEATRE · STATE STREET ★",
    showQuote: "“THE LOOP’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 7:30PM · TICKETS AT THE BOX OFFICE",
    mktTop: "LASALLE STREET // GLOBAL INDICES LIVE",
    techTop: "MICHIGAN AVENUE FLAGSHIP · CHICAGO",
    sodaSub: "ICE COLD · ZERO SUGAR · LOOP EDITION",
    gpTop: "GT WORLD STREET SERIES · CHICAGO",
    gpCircuit: "STATE · MICHIGAN · LAKE SHORE · WACKER CIRCUIT",
    newsCam: "RIVERWALK CAM · 38°F",
    newsHead: "LOOP NIGHT GRAND PRIX",
    newsSub: "MICHIGAN AVENUE & WACKER DRIVE CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET UNDER THE ELEVATED TRACKS",
    newsTransit: "CTA: L TRAINS ON TIME · LAKE SHORE DRIVE CLEAR · WEATHER: WINDY · 38°F",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS STATE ST · 70MM",
    filmName: "REDLINE CHICAGO",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE CHICAGO\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "MID 400",
    idx2: "NA 500",
    shops: [["LOOP PHARMACY", "24 HOUR PRESCRIPTIONS"], ["DEEP DISH PIZZERIA", "SINCE 1943"], ["HOT DOG STAND", "DRAGGED THROUGH THE GARDEN"], ["LAKESHORE BANK", "ATM 24H"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES"], ["BLUES BAR", "LIVE MUSIC NIGHTLY"], ["BLUE HOUR COFFEE", "ESPRESSO · BAKERY"], ["STATE ST ELECTRONICS", "PHONES · GADGETS"]],
  },
  miami: {
    perfTop: "BRICKELL AVENUE · PARIS · MIAMI",
    perfAddr: "MAISON VALENTIN · BRICKELL AVENUE",
    showTop: "★ MERIDIAN THEATRE · BISCAYNE BLVD ★",
    showQuote: "“MIAMI’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 9PM · TICKETS AT THE BOX OFFICE",
    mktTop: "BRICKELL // GLOBAL INDICES LIVE",
    techTop: "BRICKELL AVENUE FLAGSHIP · MIAMI",
    sodaSub: "ICE COLD · ZERO SUGAR · BISCAYNE EDITION",
    gpTop: "GT WORLD STREET SERIES · MIAMI",
    gpCircuit: "BISCAYNE · BRICKELL · FLAGLER · BAYFRONT CIRCUIT",
    newsCam: "BAYFRONT PARK CAM · 77°F",
    newsHead: "MIAMI NIGHT GRAND PRIX",
    newsSub: "BISCAYNE BOULEVARD & BRICKELL CLOSED FOR STREET CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED BISCAYNE",
    newsTransit: "METROMOVER: ON TIME · I-95 CLEAR · WEATHER: TROPICAL SHOWERS · 77°F",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS FLAGLER · 70MM",
    filmName: "REDLINE MIAMI",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE MIAMI\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "FLA 100",
    idx2: "NA 500",
    shops: [["FARMACIA DOWNTOWN", "PHARMACY · 24 HOURS"], ["CAFECITO VENTANITA", "CUBAN COFFEE · CROQUETAS"], ["SEAFOOD SHACK", "STONE CRAB · CEVICHE"], ["BISCAYNE BANK", "ATM 24H"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES"], ["NEON ROOFTOP", "COCKTAILS · DJ"], ["BLUE HOUR COFFEE", "ESPRESSO · BAKERY"], ["FLAGLER ELECTRONICS", "PHONES · GADGETS"]],
  },
  sanfrancisco: {
    perfTop: "UNION SQUARE · PARIS · SAN FRANCISCO",
    perfAddr: "MAISON VALENTIN · UNION SQUARE",
    showTop: "★ MERIDIAN THEATRE · GEARY STREET ★",
    showQuote: "“SAN FRANCISCO’S MOST ELECTRIFYING NIGHT” — THE EVENING CHRONICLE",
    showTime: "TONIGHT 8PM · TICKETS AT THE BOX OFFICE",
    mktTop: "FINANCIAL DISTRICT // GLOBAL INDICES LIVE",
    techTop: "UNION SQUARE FLAGSHIP · SAN FRANCISCO",
    sodaSub: "ICE COLD · ZERO SUGAR · UNION SQUARE EDITION",
    gpTop: "GT WORLD STREET SERIES · SAN FRANCISCO",
    gpCircuit: "POWELL · CALIFORNIA · MASON · MARKET CIRCUIT",
    newsCam: "NOB HILL CAM · 54°F",
    newsHead: "SAN FRANCISCO NIGHT GRAND PRIX",
    newsSub: "POWELL & CALIFORNIA STREETS CLOSED FOR THE HILL CIRCUIT",
    newsBreak: "BREAKING NEWS   RECORD LAP TIMES SET ON FOG-SLICKED NOB HILL",
    newsTransit: "MUNI: CABLE CARS ON TIME · BAY BRIDGE CLEAR · WEATHER: FOG · 54°F",
    filmTop: "FILMED IN 70MM · GRAND CINEMAS MARKET ST · 70MM",
    filmName: "REDLINE SAN FRANCISCO",
    filmCredits: "METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION \"REDLINE SAN FRANCISCO\" · SOUNDTRACK IN IMMERSIVE SOUND",
    idx1: "BAY 100",
    idx2: "NA 500",
    shops: [["UNION SQUARE PHARMACY", "24 HOUR PRESCRIPTIONS"], ["SOURDOUGH BAKERY", "SINCE 1849"], ["DIM SUM PALACE", "CHINATOWN"], ["GOLDEN GATE BANK", "ATM 24H"], ["VARENNE & CO. TIMEPIECES", "SWISS WATCHES"], ["CABLE CAR SALOON", "COCKTAILS · SINCE 1907"], ["BLUE HOUR COFFEE", "POUR OVER · BAKERY"], ["MARKET ST ELECTRONICS", "PHONES · GADGETS"]],
  },
};
let S: SignTexts = NYC_TEXT;
/** The city whose names the signs carry; call before getSignAtlasTexture(). */
export function setSignCity(id: string) { S = { ...NYC_TEXT, ...(CITY_TEXT[id] ?? {}) }; cachedAtlas = null; }

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBillboard(ctx: CanvasRenderingContext2D, idx: number, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x, y);

  if (idx === 0) {
    // 0: LUXURY FASHION / PARFUMS EDITORIAL ("MAISON NOIR PARIS // NEW YORK")
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#07080c');
    bg.addColorStop(0.55, '#181210');
    bg.addColorStop(1, '#2b1b12');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Warm golden studio key light glow
    const glow = ctx.createRadialGradient(w * 0.68, h * 0.48, 10, w * 0.68, h * 0.48, h * 0.78);
    glow.addColorStop(0, 'rgba(255, 206, 138, 0.92)');
    glow.addColorStop(0.45, 'rgba(214, 134, 66, 0.38)');
    glow.addColorStop(1, 'rgba(10, 8, 12, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Luxury glass perfume flacon with refraction highlights
    const bx = w * 0.63, by = h * 0.24, bw = w * 0.14, bh = h * 0.56;
    const flacon = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
    flacon.addColorStop(0, '#fff3d1');
    flacon.addColorStop(0.3, '#d4943a');
    flacon.addColorStop(0.7, '#7a4514');
    flacon.addColorStop(1, '#f7c873');
    ctx.fillStyle = flacon;
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,245,220,0.85)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner amber liquid + black & gold label
    ctx.fillStyle = '#0c0b0e';
    ctx.fillRect(bx + bw * 0.18, by + bh * 0.28, bw * 0.64, bh * 0.36);
    ctx.strokeStyle = '#e5b869';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + bw * 0.18, by + bh * 0.28, bw * 0.64, bh * 0.36);
    ctx.fillStyle = '#f8e3b4';
    ctx.font = '700 20px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(S.perfNo, bx + bw * 0.5, by + bh * 0.49);

    // Bottle cap
    ctx.fillStyle = '#e8c47c';
    ctx.fillRect(bx + bw * 0.32, by - bh * 0.16, bw * 0.36, bh * 0.15);

    // Editorial typography on left
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6c280';
    ctx.font = '600 18px "Inter", "Helvetica Neue", sans-serif';
    ctx.fillText(S.perfTop, 54, 68);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 68px Georgia, "Times New Roman", serif';
    ctx.fillText(S.perfName, 52, 152);
    ctx.fillStyle = 'rgba(255,240,215,0.85)';
    ctx.font = '300 28px Georgia, serif';
    ctx.fillText(S.perfSub, 54, 198);
    ctx.fillStyle = '#d4af37';
    ctx.fillRect(54, 224, 190, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '500 20px "Inter", sans-serif';
    ctx.fillText(S.perfAddr, 54, 326);
  } else if (idx === 1) {
    // 1: BROADWAY MUSICAL MARQUEE ("METROPOLIS LIVE ON BROADWAY")
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, w * 0.65);
    bg.addColorStop(0, '#8f111d');
    bg.addColorStop(0.55, '#42060d');
    bg.addColorStop(1, '#120205');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Chase bulb marquee border
    ctx.strokeStyle = '#f5be4f';
    ctx.lineWidth = 4;
    ctx.strokeRect(18, 18, w - 36, h - 36);
    ctx.fillStyle = '#fff1b8';
    for (let bx = 28; bx < w - 24; bx += 28) {
      ctx.beginPath(); ctx.arc(bx, 18, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(bx, h - 18, 4.5, 0, Math.PI * 2); ctx.fill();
    }
    for (let by = 36; by < h - 24; by += 28) {
      ctx.beginPath(); ctx.arc(18, by, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(w - 18, by, 4.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd97d';
    ctx.font = '700 22px "Inter", sans-serif';
    ctx.fillText(S.showTop, w * 0.5, 76);

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255, 195, 75, 0.85)';
    ctx.shadowBlur = 24;
    ctx.font = '900 84px "Impact", "Arial Black", sans-serif';
    ctx.fillText(S.showName, w * 0.5, 188);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#ffcf70';
    ctx.font = '700 30px Georgia, serif';
    ctx.fillText(S.showQuote, w * 0.5, 246);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w * 0.32, 278, w * 0.36, 52);
    ctx.fillStyle = '#5a0812';
    ctx.font = '800 24px "Inter", sans-serif';
    ctx.fillText(S.showTime, w * 0.5, 312);
  } else if (idx === 2) {
    // 2: NASDAQ / GLOBAL MARKETS LIVE FINANCIAL TOWER
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#040d1a');
    bg.addColorStop(0.5, '#071b30');
    bg.addColorStop(1, '#030912');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Subtle cyber grid
    ctx.strokeStyle = 'rgba(38, 150, 235, 0.16)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += 48) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
    for (let gy = 0; gy < h; gy += 36) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

    // Header bar
    ctx.fillStyle = '#0b2d4f';
    ctx.fillRect(0, 0, w, 58);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '800 26px "Inter", sans-serif';
    ctx.fillText(S.mktTop, 36, 38);

    //Glowing area chart on right half
    ctx.save();
    ctx.beginPath();
    const cx0 = w * 0.48, cy0 = 80, cw = w * 0.48, ch = 190;
    const pts = [0.68, 0.62, 0.65, 0.54, 0.48, 0.52, 0.38, 0.41, 0.28, 0.22, 0.26, 0.14];
    ctx.moveTo(cx0, cy0 + ch);
    for (let i = 0; i < pts.length; i++) {
      ctx.lineTo(cx0 + (i / (pts.length - 1)) * cw, cy0 + pts[i] * ch);
    }
    ctx.lineTo(cx0 + cw, cy0 + ch);
    ctx.closePath();
    const cg = ctx.createLinearGradient(0, cy0, 0, cy0 + ch);
    cg.addColorStop(0, 'rgba(16, 235, 138, 0.55)');
    cg.addColorStop(1, 'rgba(16, 235, 138, 0.02)');
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = '#10eb8a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = cx0 + (i / (pts.length - 1)) * cw, py = cy0 + pts[i] * ch;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    // Ticker rows on left
    const rows = [
      [S.idx1, '20,842.65', '+1.84%'],
      [S.idx2, '5,914.20', '+1.12%'],
      ['NOVA', '142.88', '+4.65%'],
      ['AXON', '234.50', '+1.92%'],
    ];
    rows.forEach(([sym, val, chg], i) => {
      const ry = 104 + i * 44;
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 26px monospace';
      ctx.fillText(sym, 36, ry);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(val, 190, ry);
      ctx.fillStyle = '#10eb8a';
      ctx.fillText(chg, 355, ry);
    });

    // Bottom ticker ribbon
    ctx.fillStyle = '#061527';
    ctx.fillRect(0, h - 68, w, 68);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 24px monospace';
    ctx.fillText(S.mktRibbon, 32, h - 26);
  } else if (idx === 3) {
    // 3: TECH FLAGSHIP SMARTPHONE LAUNCH ("AETHER 16 PRO · TITANIUM")
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#05070e');
    bg.addColorStop(0.5, '#0c182e');
    bg.addColorStop(1, '#060a14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Sleek angled smartphone hardware silhouette
    ctx.save();
    ctx.translate(w * 0.7, h * 0.54);
    ctx.rotate(-0.22);
    const pw = 210, ph = 320;
    const frameG = ctx.createLinearGradient(-pw / 2, -ph / 2, pw / 2, ph / 2);
    frameG.addColorStop(0, '#e2e8f0');
    frameG.addColorStop(0.4, '#475569');
    frameG.addColorStop(1, '#94a3b8');
    ctx.fillStyle = frameG;
    roundRect(ctx, -pw / 2 - 6, -ph / 2 - 6, pw + 12, ph + 12, 32);
    ctx.fill();

    const scrG = ctx.createLinearGradient(-pw / 2, -ph / 2, pw / 2, ph / 2);
    scrG.addColorStop(0, '#0284c7');
    scrG.addColorStop(0.45, '#38bdf8');
    scrG.addColorStop(0.75, '#1e1b4b');
    scrG.addColorStop(1, '#f43f5e');
    ctx.fillStyle = scrG;
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, 26);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 20px "Inter", sans-serif';
    ctx.fillText(S.techTop, 56, 78);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 68px "Inter", "Helvetica Neue", sans-serif';
    ctx.fillText('Aether 16 Pro', 54, 158);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '400 32px "Inter", sans-serif';
    ctx.fillText('Forged in grade-5 titanium. Built for night.', 56, 212);
    ctx.fillStyle = '#38bdf8';
    roundRect(ctx, 56, 256, 240, 52, 26);
    ctx.fill();
    ctx.fillStyle = '#030712';
    ctx.font = '800 22px "Inter", sans-serif';
    ctx.fillText('AVAILABLE NOW', 88, 290);
  } else if (idx === 4) {
    // 4: ICONIC RED & WHITE BEVERAGE WAVE ("SOLARIS COLA · REAL TASTE")
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#6b040b');
    bg.addColorStop(0.45, '#d90718');
    bg.addColorStop(1, '#85050f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Dynamic white silk wave
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.72);
    ctx.bezierCurveTo(w * 0.3, h * 0.42, w * 0.62, h * 0.96, w, h * 0.58);
    ctx.lineTo(w, h * 0.78);
    ctx.bezierCurveTo(w * 0.62, h * 1.12, w * 0.3, h * 0.58, 0, h * 0.88);
    ctx.closePath();
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 86px Georgia, "Times New Roman", serif';
    ctx.fillText('Solaris Classic', w * 0.5, 156);
    ctx.font = '700 28px "Inter", sans-serif';
    ctx.fillText(S.sodaSub, w * 0.5, 214);
  } else if (idx === 5) {
    // 5: AUTOMOTIVE / SUPERCAR WORLD SERIES ("OPEN GRID // MIDTOWN GP")
    const bg = ctx.createLinearGradient(0, 0, w, 0);
    bg.addColorStop(0, '#07090e');
    bg.addColorStop(0.55, '#111827');
    bg.addColorStop(1, '#1e3a8a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Diagonal racing speed stripes
    ctx.fillStyle = '#ff2a4b';
    ctx.beginPath();
    ctx.moveTo(w * 0.58, 0); ctx.lineTo(w * 0.66, 0); ctx.lineTo(w * 0.52, h); ctx.lineTo(w * 0.44, h);
    ctx.fill();
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(w * 0.68, 0); ctx.lineTo(w * 0.72, 0); ctx.lineTo(w * 0.58, h); ctx.lineTo(w * 0.54, h);
    ctx.fill();

    ctx.fillStyle = '#ff2a4b';
    ctx.font = '800 22px "Inter", sans-serif';
    ctx.fillText(S.gpTop, 48, 72);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 76px "Impact", "Arial Black", sans-serif';
    ctx.fillText('OPEN GRID GP', 48, 166);
    ctx.fillStyle = '#fbbf24';
    ctx.font = '700 30px "Inter", sans-serif';
    ctx.fillText('VELA GT-R · 9,000 RPM NATURALLY ASPIRATED', 48, 224);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 22px monospace';
    ctx.fillText(S.gpCircuit, 48, 318);
  } else if (idx === 6) {
    // 6: 24-HOUR LIVE NETWORK NEWS & WEATHER ("NY1 / METRO NEWS HD")
    ctx.fillStyle = '#08142c';
    ctx.fillRect(0, 0, w, h);

    // Studio skyline accent
    const sg = ctx.createLinearGradient(0, 0, w, h * 0.7);
    sg.addColorStop(0, '#0f295c');
    sg.addColorStop(1, '#1d4ed8');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, w, h * 0.68);

    // "LIVE" badge
    ctx.fillStyle = '#dc2626';
    roundRect(ctx, 42, 34, 118, 44, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 24px "Inter", sans-serif';
    ctx.fillText('● LIVE', 60, 65);
    ctx.fillStyle = '#93c5fd';
    ctx.font = '700 24px "Inter", sans-serif';
    ctx.fillText(S.newsCam, 182, 65);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 58px "Inter", sans-serif';
    ctx.fillText(S.newsHead, 42, 156);
    ctx.fillStyle = '#fde047';
    ctx.font = '700 30px "Inter", sans-serif';
    ctx.fillText(S.newsSub, 42, 210);

    // Lower third breaking news banner
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(0, h - 110, w, 54);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 26px "Inter", sans-serif';
    ctx.fillText(S.newsBreak, 42, h - 74);

    // Bottom yellow ticker
    ctx.fillStyle = '#facc15';
    ctx.fillRect(0, h - 56, w, 56);
    ctx.fillStyle = '#090d16';
    ctx.font = '800 24px monospace';
    ctx.fillText(S.newsTransit, 42, h - 20);
  } else {
    // 7: IMAX 70MM BLOCKBUSTER KEY ART ("SHADOW OVER MANHATTAN")
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#041f2e');
    bg.addColorStop(0.55, '#0c3b4f');
    bg.addColorStop(0.75, '#7c2d12');
    bg.addColorStop(1, '#090a0f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Anamorphic orange horizon flare
    const fl = ctx.createRadialGradient(w * 0.5, h * 0.56, 8, w * 0.5, h * 0.56, w * 0.55);
    fl.addColorStop(0, 'rgba(255, 180, 90, 0.95)');
    fl.addColorStop(0.35, 'rgba(249, 115, 22, 0.45)');
    fl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fl;
    ctx.fillRect(0, h * 0.32, w, h * 0.48);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '600 20px "Inter", sans-serif';
    ctx.fillText(S.filmTop, w * 0.5, 68);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 76px "Inter", "Arial Black", sans-serif';
    ctx.fillText(S.filmName, w * 0.5, 178);
    ctx.fillStyle = '#fed7aa';
    ctx.font = '700 26px "Inter", sans-serif';
    ctx.fillText('EVERY STREET HAS A PRICE · IN THEATRES FRIDAY', w * 0.5, 232);
    ctx.fillStyle = 'rgba(203, 213, 225, 0.65)';
    ctx.font = '500 15px monospace';
    ctx.fillText(S.filmCredits, w * 0.5, 342);
  }

  ctx.restore();
}

function drawShopSign(ctx: CanvasRenderingContext2D, idx: number, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x, y);

  const C = [
    { bg: '#0c111d', border: '#38bdf8', fg: '#ffffff', sub: '#38bdf8' },
    { bg: '#16090b', border: '#f59e0b', fg: '#fde68a', sub: '#f87171' },
    { bg: '#091410', border: '#34d399', fg: '#ecfdf5', sub: '#6ee7b7' },
    { bg: '#0a0d18', border: '#60a5fa', fg: '#ffffff', sub: '#93c5fd' },
    { bg: '#14110c', border: '#d4af37', fg: '#fffbeb', sub: '#fcd34d' },
    { bg: '#110c18', border: '#f472b6', fg: '#fdf2f8', sub: '#f9a8d4' },
    { bg: '#0e1318', border: '#e2e8f0', fg: '#f8fafc', sub: '#94a3b8' },
    { bg: '#180c0c', border: '#ef4444', fg: '#ffffff', sub: '#fca5a5' },
  ];
  const specs = C.map((c, i) => ({ ...c, title: S.shops[i][0], tag: S.shops[i][1] }));
  const s = specs[idx % specs.length];
  ctx.fillStyle = s.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = s.border;
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, w - 16, h - 16);

  ctx.textAlign = 'center';
  ctx.fillStyle = s.fg;
  ctx.shadowColor = s.border;
  ctx.shadowBlur = 12;
  ctx.font = '800 44px "Inter", "Helvetica Neue", Arial, sans-serif';
  ctx.fillText(s.title, w * 0.5, 64);
  ctx.shadowBlur = 0;

  ctx.fillStyle = s.sub;
  ctx.font = '700 20px "Inter", monospace';
  ctx.fillText(s.tag, w * 0.5, 102);

  ctx.restore();
}

export function getSignAtlasTexture(): THREE.CanvasTexture {
  if (cachedAtlas) return cachedAtlas;
  const W = 2048, H = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, W, H);

  // Top 1536 px: 4 rows x 2 cols of 1024x384 billboards (indices 0..7)
  for (let i = 0; i < 8; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    drawBillboard(ctx, i, col * 1024, row * 384, 1024, 384);
  }
  // Bottom 512 px: 4 rows x 2 cols of 1024x128 storefront signs (indices 0..7)
  for (let i = 0; i < 8; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    drawShopSign(ctx, i, col * 1024, 1536 + row * 128, 1024, 128);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cachedAtlas = tex;
  return tex;
}
