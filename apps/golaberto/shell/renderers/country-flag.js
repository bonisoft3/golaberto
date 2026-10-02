// The original archive serves English country filenames, including the
// football nations of the UK; seed fixtures also carry Portuguese names.
export default function render(value) {
  const country = String(value).split(" - ")[0].trim();
  if (!country) return [];
  const aliases = {
    "Brasil": "Brazil", "Inglaterra": "England", "Espanha": "Spain",
    "Itália": "Italy", "Alemanha": "Germany", "França": "France",
    "Suíça": "Switzerland", "Colômbia": "Colombia", "Estados Unidos": "United States",
    "Países Baixos": "Netherlands", "Bélgica": "Belgium", "Dinamarca": "Denmark",
    "Escócia": "Scotland", "País de Gales": "Wales", "Irlanda do Norte": "Northern Ireland",
    "Croácia": "Croatia", "Sérvia": "Serbia", "Polônia": "Poland", "Japão": "Japan",
    "Coreia do Sul": "South Korea", "México": "Mexico", "Egito": "Egypt",
    "Marrocos": "Morocco", "Nigéria": "Nigeria", "Senegal": "Senegal",
    "Uruguai": "Uruguay", "Paraguai": "Paraguay", "Peru": "Peru",
    "Equador": "Ecuador", "Venezuela": "Venezuela", "Bolívia": "Bolivia",
    "Mundial": "fifa", "World": "fifa", "Europa": "uefa", "Europe": "uefa",
    "América do Sul": "conmebol", "South America": "conmebol",
    "Africa": "caf", "África": "caf", "Asia": "afc", "Ásia": "afc",
    "Oceania": "ofc", "North/Central America & Caribbean": "concacaf"
  };
  const file = (aliases[country] || country).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!file) return [];
  return [{tag: "img", attrs: {src: "https://d24oxbyqb2c11t.cloudfront.net/countries/flags/" + file + "_15.png",
    alt: "", width: 15, height: 15, loading: "lazy"}}];
}

render;
