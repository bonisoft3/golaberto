export default function render(value) {
  const [latText, lonText, title, missing] = String(value).split('|');
  if (!latText || !lonText) return [{tag:'p',attrs:{class:'team-location'},children:[missing]}];
  const lat = Number(latText), lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180) return [{tag:'p',attrs:{class:'team-location'},children:[missing]}];
  return [{tag:'p',attrs:{class:'team-location'},children:[{tag:'a',attrs:{href:`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`,target:'_blank',rel:'noopener noreferrer'},children:[title]}]}];
}

render;
