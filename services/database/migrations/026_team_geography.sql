-- Fixed archive geography and multilingual filters for the ranked teams directory.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

CREATE TABLE IF NOT EXISTS geography_region (
  id text PRIMARY KEY, name text NOT NULL,
  message_key text NOT NULL,
  search_key text COLLATE golaberto_search NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CREATE TABLE IF NOT EXISTS geography_country (
  id text PRIMARY KEY, name text NOT NULL,
  region_id text NOT NULL,
  message_key text NOT NULL, aliases text NOT NULL,
  search_key text COLLATE golaberto_search NOT NULL,
  region_search_key text COLLATE golaberto_search NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);

-- A fresh Pronto baseline declares the fields with their portable type's default
-- collation; change only incorrect columns so replay preserves dependent views.
DO $$ DECLARE target text; col text; BEGIN
  FOREACH target IN ARRAY ARRAY['geography_region','geography_country'] LOOP
    FOREACH col IN ARRAY ARRAY['search_key','region_search_key'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=target::regclass
                 AND attname=col AND attcollation <> 'golaberto_search'::regcollation) THEN
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE text COLLATE golaberto_search', target,col);
      END IF;
    END LOOP;
    CALL rls_protect(target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',target||'_app_user_select',target);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_user USING (true)',target||'_app_user_select',target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',target||'_service_all',target);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service USING (true) WITH CHECK (true)',target||'_service_all',target);
    EXECUTE format('REVOKE ALL ON %I FROM anon,app_user',target);
    EXECUTE format('GRANT SELECT ON %I TO anon,app_user,electric',target);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service',target);
    EXECUTE format('DROP TRIGGER IF EXISTS restamp_txid ON %I',target);
    EXECUTE format('CREATE TRIGGER restamp_txid BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION restamp_txid()',target);
    EXECUTE format('ALTER TABLE %I REPLICA IDENTITY FULL',target);
  END LOOP;
END $$;
-- tier: container
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['geography_region','geography_country'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_default'
                   AND schemaname='public' AND tablename=target) THEN
      EXECUTE format('ALTER PUBLICATION electric_publication_default ADD TABLE %I',target);
    END IF;
  END LOOP;
END $$;
-- tier: any

-- Source: geography.json, original ApplicationHelper fixed football memberships.
-- Stable names also identify original flag files. Greenland has no parent upstream.
INSERT INTO geography_region AS r (id,name,message_key,search_key) VALUES
  ('africa','Africa','geography_region_africa','áfrica africa áfrica africa afrika afrique'),
  ('asia','Asia','geography_region_asia','ásia asia asia asia asien asie'),
  ('concacaf','North/Central America & Caribbean','geography_region_concacaf','américa do norte/central e caribe north/central america & caribbean américa del norte/central y el caribe america del nord/centrale e caraibi nord-/mittelamerika und karibik amérique du nord/centrale et caraïbes'),
  ('europe','Europe','geography_region_europe','europa europe europa europa europa europe'),
  ('oceania','Oceania','geography_region_oceania','oceania oceania oceanía oceania ozeanien océanie'),
  ('south_america','South America','geography_region_south_america','américa do sul south america américa del sur america del sud südamerika amérique du sud')
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,message_key=EXCLUDED.message_key,search_key=EXCLUDED.search_key
WHERE (r.name,r.message_key,r.search_key) IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.message_key,EXCLUDED.search_key);

INSERT INTO geography_country AS c (id,name,region_id,message_key,aliases,search_key,region_search_key)
SELECT src.id,src.name,src.region_id,src.message_key,src.aliases,
  replace(replace(replace((SELECT string_agg(a.value,' ') FROM jsonb_array_elements_text(src.aliases::jsonb) a(value)), 'ı','i'),'þ','th'),'Þ','th'),
  coalesce(r.search_key,'') || ' world mundo mundial monde welt mondo'
FROM (VALUES
  ('dz','Algeria','africa','geography_country_dz','["Algeria","Argélia","Argelia","Algerien","Algérie"]'),
  ('ao','Angola','africa','geography_country_ao','["Angola"]'),
  ('bj','Benin','africa','geography_country_bj','["Benin","Benín","Bénin"]'),
  ('bw','Botswana','africa','geography_country_bw','["Botswana","Botsuana"]'),
  ('bf','Burkina Faso','africa','geography_country_bf','["Burkina Faso"]'),
  ('bi','Burundi','africa','geography_country_bi','["Burundi"]'),
  ('cm','Cameroon','africa','geography_country_cm','["Cameroon","Camarões","Camerún","Camerun","Kamerun","Cameroun"]'),
  ('cv','Cape Verde','africa','geography_country_cv','["Cape Verde","Cabo Verde","Capo Verde","Cap-Vert"]'),
  ('cf','Central African Republic','africa','geography_country_cf','["Central African Republic","República Centro-Africana","República Centroafricana","Repubblica Centrafricana","Zentralafrikanische Republik","République centrafricaine"]'),
  ('td','Chad','africa','geography_country_td','["Chad","Chade","Ciad","Tschad","Tchad"]'),
  ('km','Comoros','africa','geography_country_km','["Comoros","Comores","Comoras","Comore","Komoren"]'),
  ('cg','Congo','africa','geography_country_cg','["Congo","República del Congo","Congo-Brazzaville","Kongo-Brazzaville"]'),
  ('cd','DR Congo','africa','geography_country_cd','["DR Congo","Congo RD","República Democrática del Congo","Congo - Kinshasa","Kongo-Kinshasa","Congo-Kinshasa"]'),
  ('dj','Djibouti','africa','geography_country_dj','["Djibouti","Yibuti","Gibuti","Dschibuti"]'),
  ('eg','Egypt','africa','geography_country_eg','["Egypt","Egito","Egipto","Egitto","Ägypten","Égypte"]'),
  ('gq','Equatorial Guinea','africa','geography_country_gq','["Equatorial Guinea","Guiné Equatorial","Guinea Ecuatorial","Guinea Equatoriale","Äquatorialguinea","Guinée équatoriale"]'),
  ('er','Eritrea','africa','geography_country_er','["Eritrea","Eritréia","Érythrée"]'),
  ('et','Ethiopia','africa','geography_country_et','["Ethiopia","Etiópia","Etiopía","Etiopia","Äthiopien","Éthiopie"]'),
  ('ga','Gabon','africa','geography_country_ga','["Gabon","Gabão","Gabón","Gabun"]'),
  ('gm','Gambia','africa','geography_country_gm','["Gambia","Gâmbia","Gambie"]'),
  ('gh','Ghana','africa','geography_country_gh','["Ghana","Gana"]'),
  ('gn','Guinea','africa','geography_country_gn','["Guinea","Guiné","Guinée"]'),
  ('gw','Guinea-Bissau','africa','geography_country_gw','["Guinea-Bissau","Guiné-Bissau","Guinea-Bisáu","Guinée-Bissau"]'),
  ('ci','Ivory Coast','africa','geography_country_ci','["Ivory Coast","Costa do Marfim","Costa de Marfil","Costa d’Avorio","Côte d’Ivoire"]'),
  ('ke','Kenya','africa','geography_country_ke','["Kenya","Quênia","Kenia"]'),
  ('ls','Lesotho','africa','geography_country_ls','["Lesotho","Lesoto"]'),
  ('lr','Liberia','africa','geography_country_lr','["Liberia","Libéria"]'),
  ('ly','Libya','africa','geography_country_ly','["Libya","Líbia","Libia","Libyen","Libye"]'),
  ('mg','Madagascar','africa','geography_country_mg','["Madagascar","Madagaskar"]'),
  ('mw','Malawi','africa','geography_country_mw','["Malawi","Malaui"]'),
  ('ml','Mali','africa','geography_country_ml','["Mali"]'),
  ('mr','Mauritania','africa','geography_country_mr','["Mauritania","Mauritânia","Mauretanien","Mauritanie"]'),
  ('mu','Mauritius','africa','geography_country_mu','["Mauritius","Maurício","Mauricio","Maurice"]'),
  ('ma','Morocco','africa','geography_country_ma','["Morocco","Marrocos","Marruecos","Marocco","Marokko","Maroc"]'),
  ('mz','Mozambique','africa','geography_country_mz','["Mozambique","Moçambique","Mozambico","Mosambik"]'),
  ('na','Namibia','africa','geography_country_na','["Namibia","Namíbia","Namibie"]'),
  ('ne','Niger','africa','geography_country_ne','["Niger","Níger"]'),
  ('ng','Nigeria','africa','geography_country_ng','["Nigeria","Nigéria"]'),
  ('re','Reunion','africa','geography_country_re','["Reunion","Reunião","Reunión","Riunione","Réunion","La Réunion"]'),
  ('rw','Rwanda','africa','geography_country_rw','["Rwanda","Ruanda"]'),
  ('st','Sao Tome and Principe','africa','geography_country_st','["Sao Tome and Principe","São Tomé e Príncipe","Santo Tomé y Príncipe","São Tomé und Príncipe","Sao Tomé-et-Principe"]'),
  ('sn','Senegal','africa','geography_country_sn','["Senegal","Sénégal"]'),
  ('sc','Seychelles','africa','geography_country_sc','["Seychelles","Seychellen"]'),
  ('sl','Sierra Leone','africa','geography_country_sl','["Sierra Leone","Serra Leoa","Sierra Leona"]'),
  ('so','Somalia','africa','geography_country_so','["Somalia","Somália","Somalie"]'),
  ('za','South Africa','africa','geography_country_za','["South Africa","África do Sul","Sudáfrica","Sudafrica","Südafrika","Afrique du Sud"]'),
  ('ss','South Sudan','africa','geography_country_ss','["South Sudan","Sudão do Sul","Sudán del Sur","Sud Sudan","Südsudan","Soudan du Sud"]'),
  ('sd','Sudan','africa','geography_country_sd','["Sudan","Sudão","Sudán","Soudan"]'),
  ('sz','Swaziland','africa','geography_country_sz','["Swaziland","Suazilândia","Esuatini","Eswatini"]'),
  ('tz','Tanzania','africa','geography_country_tz','["Tanzania","Tanzânia","Tansania","Tanzanie"]'),
  ('tg','Togo','africa','geography_country_tg','["Togo"]'),
  ('tn','Tunisia','africa','geography_country_tn','["Tunisia","Tunísia","Túnez","Tunesien","Tunisie"]'),
  ('ug','Uganda','africa','geography_country_ug','["Uganda","Ouganda"]'),
  ('zm','Zambia','africa','geography_country_zm','["Zambia","Zâmbia","Sambia","Zambie"]'),
  ('zw','Zimbabwe','africa','geography_country_zw','["Zimbabwe","Zimbábue","Zimbabue","Simbabwe"]'),
  ('af','Afghanistan','asia','geography_country_af','["Afghanistan","Afeganistão","Afganistán"]'),
  ('au','Australia','asia','geography_country_au','["Australia","Austrália","Australien","Australie"]'),
  ('bh','Bahrain','asia','geography_country_bh','["Bahrain","Bahrein","Baréin","Bahreïn"]'),
  ('bd','Bangladesh','asia','geography_country_bd','["Bangladesh","Bangladés","Bangladesch"]'),
  ('bt','Bhutan','asia','geography_country_bt','["Bhutan","Butão","Bután","Bhoutan"]'),
  ('bn','Brunei','asia','geography_country_bn','["Brunei","Brunéi","Brunei Darussalam"]'),
  ('kh','Cambodia','asia','geography_country_kh','["Cambodia","Camboja","Camboya","Cambogia","Kambodscha","Cambodge"]'),
  ('cn','China','asia','geography_country_cn','["China","Cina","Chine"]'),
  ('tl','East Timor','asia','geography_country_tl','["East Timor","Timor Leste","Timor-Leste","Timor Est","Timor oriental"]'),
  ('gu','Guam','asia','geography_country_gu','["Guam"]'),
  ('hk','Hong Kong','asia','geography_country_hk','["Hong Kong","RAE de Hong Kong (China)","RAS di Hong Kong","Sonderverwaltungsregion Hongkong","R.A.S. chinoise de Hong Kong"]'),
  ('in','India','asia','geography_country_in','["India","Índia","Indien","Inde"]'),
  ('ir','Iran','asia','geography_country_ir','["Iran","Irã","Irán"]'),
  ('id','Indonesia','asia','geography_country_id','["Indonesia","Indonésia","Indonesien","Indonésie"]'),
  ('iq','Iraq','asia','geography_country_iq','["Iraq","Iraque","Irak"]'),
  ('jp','Japan','asia','geography_country_jp','["Japan","Japão","Japón","Giappone","Japon"]'),
  ('jo','Jordan','asia','geography_country_jo','["Jordan","Jordânia","Jordania","Giordania","Jordanien","Jordanie"]'),
  ('kw','Kuwait','asia','geography_country_kw','["Kuwait","Koweït"]'),
  ('kg','Kyrgyzstan','asia','geography_country_kg','["Kyrgyzstan","Quirguistão","Kirguistán","Kirghizistan","Kirgisistan","Kirghizstan"]'),
  ('la','Lao People''s Democratic Republic','asia','geography_country_la','["Lao People''s Democratic Republic","Laos"]'),
  ('lb','Lebanon','asia','geography_country_lb','["Lebanon","Líbano","Libano","Libanon","Liban"]'),
  ('mo','Macau','asia','geography_country_mo','["Macau","RAE de Macao (China)","RAS di Macao","Sonderverwaltungsregion Macau","R.A.S. chinoise de Macao"]'),
  ('my','Malaysia','asia','geography_country_my','["Malaysia","Malásia","Malasia","Malaisie"]'),
  ('mv','Maldives','asia','geography_country_mv','["Maldives","Maldivas","Maldive","Malediven"]'),
  ('mn','Mongolia','asia','geography_country_mn','["Mongolia","Mongólia","Mongolei","Mongolie"]'),
  ('mm','Myanmar','asia','geography_country_mm','["Myanmar","Myanmar (Birmania)","Myanmar (Birmanie)"]'),
  ('np','Nepal','asia','geography_country_np','["Nepal","Népal"]'),
  ('kp','North Korea','asia','geography_country_kp','["North Korea","Coréia do Norte","Corea del Norte","Corea del Nord","Nordkorea","Corée du Nord"]'),
  ('mp','Northern Mariana Islands','asia','geography_country_mp','["Northern Mariana Islands","Marianas Setentrionais","Islas Marianas del Norte","Isole Marianne Settentrionali","Nördliche Marianen","Îles Mariannes du Nord"]'),
  ('om','Oman','asia','geography_country_om','["Oman","Omã","Omán"]'),
  ('pk','Pakistan','asia','geography_country_pk','["Pakistan","Paquistão","Pakistán"]'),
  ('ps','Palestine','asia','geography_country_ps','["Palestine","Palestina","Territorios Palestinos","Territori Palestinesi","Palästinensische Autonomiegebiete","Territoires palestiniens"]'),
  ('ph','Philippines','asia','geography_country_ph','["Philippines","Filipinas","Filippine","Philippinen"]'),
  ('qa','Qatar','asia','geography_country_qa','["Qatar","Catar","Katar"]'),
  ('sa','Saudi Arabia','asia','geography_country_sa','["Saudi Arabia","Arábia Saudita","Arabia Saudita","Saudi-Arabien","Arabie saoudite"]'),
  ('sg','Singapore','asia','geography_country_sg','["Singapore","Cingapura","Singapur","Singapour"]'),
  ('kr','South Korea','asia','geography_country_kr','["South Korea","Coréia do Sul","Corea del Sur","Corea del Sud","Südkorea","Corée du Sud","Coreia do Sul"]'),
  ('lk','Sri Lanka','asia','geography_country_lk','["Sri Lanka"]'),
  ('sy','Syria','asia','geography_country_sy','["Syria","Síria","Siria","Syrien","Syrie"]'),
  ('tw','Taiwan','asia','geography_country_tw','["Taiwan","Taiwán","Taïwan"]'),
  ('tj','Tajikistan','asia','geography_country_tj','["Tajikistan","Tadjiquistão","Tayikistán","Tagikistan","Tadschikistan","Tadjikistan"]'),
  ('th','Thailand','asia','geography_country_th','["Thailand","Tailândia","Tailandia","Thailandia","Thaïlande"]'),
  ('tm','Turkmenistan','asia','geography_country_tm','["Turkmenistan","Turcomenistão","Turkmenistán","Turkménistan"]'),
  ('ae','United Arab Emirates','asia','geography_country_ae','["United Arab Emirates","Emirados Árabes Unidos","Emiratos Árabes Unidos","Emirati Arabi Uniti","Vereinigte Arabische Emirate","Émirats arabes unis"]'),
  ('uz','Uzbekistan','asia','geography_country_uz','["Uzbekistan","Uzbequistão","Uzbekistán","Usbekistan","Ouzbékistan"]'),
  ('vn','Viet Nam','asia','geography_country_vn','["Viet Nam","Vietnã","Vietnam","Viêt Nam"]'),
  ('ye','Yemen','asia','geography_country_ye','["Yemen","Iêmen","Jemen","Yémen"]'),
  ('ai','Anguilla','concacaf','geography_country_ai','["Anguilla","Anguila"]'),
  ('ag','Antigua And Barbuda','concacaf','geography_country_ag','["Antigua And Barbuda","Antígua e Barbuda","Antigua y Barbuda","Antigua e Barbuda","Antigua und Barbuda","Antigua-et-Barbuda"]'),
  ('aw','Aruba','concacaf','geography_country_aw','["Aruba"]'),
  ('bs','Bahamas','concacaf','geography_country_bs','["Bahamas"]'),
  ('bb','Barbados','concacaf','geography_country_bb','["Barbados","Barbade"]'),
  ('bz','Belize','concacaf','geography_country_bz','["Belize","Belice"]'),
  ('bm','Bermuda','concacaf','geography_country_bm','["Bermuda","Bermudas","Bermudes"]'),
  ('ca','Canada','concacaf','geography_country_ca','["Canada","Canadá","Kanada"]'),
  ('ky','Cayman Islands','concacaf','geography_country_ky','["Cayman Islands","Ilhas Caiman","Islas Caimán","Isole Cayman","Kaimaninseln","Îles Caïmans"]'),
  ('cr','Costa Rica','concacaf','geography_country_cr','["Costa Rica"]'),
  ('cu','Cuba','concacaf','geography_country_cu','["Cuba","Kuba"]'),
  ('cw','Curacao','concacaf','geography_country_cw','["Curacao","Curaçao","Curazao"]'),
  ('dm','Dominica','concacaf','geography_country_dm','["Dominica","Dominique"]'),
  ('do','Dominican Republic','concacaf','geography_country_do','["Dominican Republic","República Dominicana","Repubblica Dominicana","Dominikanische Republik","République dominicaine"]'),
  ('sv','El Salvador','concacaf','geography_country_sv','["El Salvador","Salvador"]'),
  ('gf','French Guiana','concacaf','geography_country_gf','["French Guiana","Guiana Francesa","Guayana Francesa","Guyana Francese","Französisch-Guayana","Guyane française"]'),
  ('gd','Grenada','concacaf','geography_country_gd','["Grenada","Granada","Grenade"]'),
  ('gp','Guadeloupe','concacaf','geography_country_gp','["Guadeloupe","Guadalupe","Guadalupa"]'),
  ('gt','Guatemala','concacaf','geography_country_gt','["Guatemala"]'),
  ('gy','Guyana','concacaf','geography_country_gy','["Guyana","Guiana"]'),
  ('ht','Haiti','concacaf','geography_country_ht','["Haiti","Haití","Haïti"]'),
  ('hn','Honduras','concacaf','geography_country_hn','["Honduras"]'),
  ('jm','Jamaica','concacaf','geography_country_jm','["Jamaica","Giamaica","Jamaika","Jamaïque"]'),
  ('mq','Martinique','concacaf','geography_country_mq','["Martinique","Martinica"]'),
  ('mx','Mexico','concacaf','geography_country_mx','["Mexico","México","Messico","Mexiko","Mexique"]'),
  ('ms','Montserrat','concacaf','geography_country_ms','["Montserrat"]'),
  ('ni','Nicaragua','concacaf','geography_country_ni','["Nicaragua","Nicarágua"]'),
  ('pa','Panama','concacaf','geography_country_pa','["Panama","Panamá"]'),
  ('pr','Puerto Rico','concacaf','geography_country_pr','["Puerto Rico","Porto Rico","Portorico"]'),
  ('kn','Saint Kitts and Nevis','concacaf','geography_country_kn','["Saint Kitts and Nevis","São Cristóvão e Neves","San Cristóbal y Nieves","Saint Kitts e Nevis","St. Kitts und Nevis","Saint-Christophe-et-Niévès"]'),
  ('lc','Saint Lucia','concacaf','geography_country_lc','["Saint Lucia","Santa Lúcia","Santa Lucía","St. Lucia","Sainte-Lucie"]'),
  ('mf','Saint Martin','concacaf','geography_country_mf','["Saint Martin","São Martinho (França)","San Martín","St. Martin","Saint-Martin"]'),
  ('vc','Saint Vincent and the Grenadines','concacaf','geography_country_vc','["Saint Vincent and the Grenadines","São Vicente e Granadinas","San Vicente y las Granadinas","Saint Vincent e Grenadine","St. Vincent und die Grenadinen","Saint-Vincent-et-les Grenadines"]'),
  ('sx','Sint Maarten','concacaf','geography_country_sx','["Sint Maarten","São Martinho (Holanda)","Saint-Martin (partie néerlandaise)"]'),
  ('sr','Suriname','concacaf','geography_country_sr','["Suriname","Surinam"]'),
  ('tt','Trinidad and Tobago','concacaf','geography_country_tt','["Trinidad and Tobago","Trindade e Tobago","Trinidad y Tobago","Trinidad e Tobago","Trinidad und Tobago","Trinité-et-Tobago"]'),
  ('tc','Turks and Caicos Islands','concacaf','geography_country_tc','["Turks and Caicos Islands","Turks e Caicos","Islas Turcas y Caicos","Isole Turks e Caicos","Turks- und Caicosinseln","Îles Turques-et-Caïques"]'),
  ('us','United States','concacaf','geography_country_us','["United States","Estados Unidos","Stati Uniti","Vereinigte Staaten","États-Unis"]'),
  ('vg','Virgin Islands (British)','concacaf','geography_country_vg','["Virgin Islands (British)","Ilhas Virgens Britânicas","Islas Vírgenes Británicas","Isole Vergini Britanniche","Britische Jungferninseln","Îles Vierges britanniques"]'),
  ('vi','Virgin Islands (U.S.)','concacaf','geography_country_vi','["Virgin Islands (U.S.)","Ilhas Virgens Americanas","Islas Vírgenes de EE. UU.","Isole Vergini Americane","Amerikanische Jungferninseln","Îles Vierges des États-Unis"]'),
  ('al','Albania','europe','geography_country_al','["Albania","Albânia","Albanien","Albanie"]'),
  ('ad','Andorra','europe','geography_country_ad','["Andorra","Andorre"]'),
  ('am','Armenia','europe','geography_country_am','["Armenia","Armênia","Armenien","Arménie"]'),
  ('at','Austria','europe','geography_country_at','["Austria","Áustria","Österreich","Autriche"]'),
  ('az','Azerbaijan','europe','geography_country_az','["Azerbaijan","Azerbeijão","Azerbaiyán","Azerbaigian","Aserbaidschan","Azerbaïdjan"]'),
  ('by','Belarus','europe','geography_country_by','["Belarus","Bielorrússia","Bielorrusia","Bielorussia","Biélorussie"]'),
  ('be','Belgium','europe','geography_country_be','["Belgium","Bélgica","Belgio","Belgien","Belgique"]'),
  ('ba','Bosnia and Herzegovina','europe','geography_country_ba','["Bosnia and Herzegovina","Bósnia e Herzegovina","Bosnia y Herzegovina","Bosnia ed Erzegovina","Bosnien und Herzegowina","Bosnie-Herzégovine"]'),
  ('bg','Bulgaria','europe','geography_country_bg','["Bulgaria","Bulgária","Bulgarien","Bulgarie"]'),
  ('hr','Croatia','europe','geography_country_hr','["Croatia","Croácia","Croacia","Croazia","Kroatien","Croatie"]'),
  ('cy','Cyprus','europe','geography_country_cy','["Cyprus","Chipre","Cipro","Zypern","Chypre"]'),
  ('cz','Czech Republic','europe','geography_country_cz','["Czech Republic","República Checa","Chequia","Cechia","Tschechien","Tchéquie"]'),
  ('dk','Denmark','europe','geography_country_dk','["Denmark","Dinamarca","Danimarca","Dänemark","Danemark"]'),
  ('gb_eng','England','europe','geography_country_gb_eng','["England","Inglaterra","Inghilterra","Angleterre"]'),
  ('ee','Estonia','europe','geography_country_ee','["Estonia","Estônia","Estland","Estonie"]'),
  ('fo','Faroe Islands','europe','geography_country_fo','["Faroe Islands","Ilhas Feroe","Islas Feroe","Isole Fær Øer","Färöer","Îles Féroé"]'),
  ('fi','Finland','europe','geography_country_fi','["Finland","Finlândia","Finlandia","Finnland","Finlande"]'),
  ('fr','France','europe','geography_country_fr','["France","França","Francia","Frankreich"]'),
  ('ge','Georgia','europe','geography_country_ge','["Georgia","Geórgia","Georgien","Géorgie"]'),
  ('de','Germany','europe','geography_country_de','["Germany","Alemanha","Alemania","Germania","Deutschland","Allemagne"]'),
  ('gi','Gibraltar','europe','geography_country_gi','["Gibraltar","Gibilterra"]'),
  ('gr','Greece','europe','geography_country_gr','["Greece","Grécia","Grecia","Griechenland","Grèce"]'),
  ('hu','Hungary','europe','geography_country_hu','["Hungary","Hungria","Hungría","Ungheria","Ungarn","Hongrie"]'),
  ('is','Iceland','europe','geography_country_is','["Iceland","Islândia","Islandia","Islanda","Island","Islande"]'),
  ('ie','Ireland','europe','geography_country_ie','["Ireland","Irlanda","Irland","Irlande"]'),
  ('il','Israel','europe','geography_country_il','["Israel","Israele","Israël"]'),
  ('it','Italy','europe','geography_country_it','["Italy","Itália","Italia","Italien","Italie"]'),
  ('kz','Kazakhstan','europe','geography_country_kz','["Kazakhstan","Cazaquistão","Kazajistán","Kazakistan","Kasachstan"]'),
  ('xk','Kosovo','europe','geography_country_xk','["Kosovo"]'),
  ('lv','Latvia','europe','geography_country_lv','["Latvia","Letônia","Letonia","Lettonia","Lettland","Lettonie"]'),
  ('li','Liechtenstein','europe','geography_country_li','["Liechtenstein"]'),
  ('lt','Lithuania','europe','geography_country_lt','["Lithuania","Lituânia","Lituania","Litauen","Lituanie"]'),
  ('lu','Luxembourg','europe','geography_country_lu','["Luxembourg","Luxemburgo","Lussemburgo","Luxemburg"]'),
  ('mk','Macedonia','europe','geography_country_mk','["Macedonia","Macedônia","Macedonia del Norte","Macedonia del Nord","Nordmazedonien","Macédoine du Nord"]'),
  ('mt','Malta','europe','geography_country_mt','["Malta","Malte"]'),
  ('md','Moldova','europe','geography_country_md','["Moldova","Moldávia","Moldavia","Republik Moldau","Moldavie"]'),
  ('mc','Monaco','europe','geography_country_mc','["Monaco","Mônaco","Mónaco"]'),
  ('me','Montenegro','europe','geography_country_me','["Montenegro","Monténégro"]'),
  ('nl','Netherlands','europe','geography_country_nl','["Netherlands","Holanda","Países Bajos","Paesi Bassi","Niederlande","Pays-Bas","Países Baixos"]'),
  ('gb_nir','Northern Ireland','europe','geography_country_gb_nir','["Northern Ireland","Irlanda do Norte","Irlanda del Norte","Irlanda del Nord","Nordirland","Irlande du Nord"]'),
  ('no','Norway','europe','geography_country_no','["Norway","Noruega","Norvegia","Norwegen","Norvège"]'),
  ('pl','Poland','europe','geography_country_pl','["Poland","Polônia","Polonia","Polen","Pologne"]'),
  ('pt','Portugal','europe','geography_country_pt','["Portugal","Portogallo"]'),
  ('ro','Romania','europe','geography_country_ro','["Romania","Romênia","Rumania","Rumänien","Roumanie"]'),
  ('ru','Russia','europe','geography_country_ru','["Russia","Rússia","Rusia","Russland","Russie"]'),
  ('sm','San Marino','europe','geography_country_sm','["San Marino","Saint-Marin"]'),
  ('gb_sct','Scotland','europe','geography_country_gb_sct','["Scotland","Escócia","Escocia","Scozia","Schottland","Écosse"]'),
  ('rs','Serbia','europe','geography_country_rs','["Serbia","Sérvia","Serbien","Serbie"]'),
  ('cs','Serbia and Montenegro','europe','geography_country_cs','["Serbia and Montenegro","Sérvia e Montenegro","Serbia y Montenegro","Serbia e Montenegro","Serbien und Montenegro","Serbie-et-Monténégro"]'),
  ('sk','Slovakia','europe','geography_country_sk','["Slovakia","Eslováquia","Eslovaquia","Slovacchia","Slowakei","Slovaquie"]'),
  ('si','Slovenia','europe','geography_country_si','["Slovenia","Eslovênia","Eslovenia","Slowenien","Slovénie"]'),
  ('es','Spain','europe','geography_country_es','["Spain","Espanha","España","Spagna","Spanien","Espagne"]'),
  ('se','Sweden','europe','geography_country_se','["Sweden","Suécia","Suecia","Svezia","Schweden","Suède"]'),
  ('ch','Switzerland','europe','geography_country_ch','["Switzerland","Suíça","Suiza","Svizzera","Schweiz","Suisse"]'),
  ('tr','Turkey','europe','geography_country_tr','["Turkey","Turquia","Turquía","Turchia","Türkei","Turquie"]'),
  ('ua','Ukraine','europe','geography_country_ua','["Ukraine","Ucrânia","Ucrania","Ucraina"]'),
  ('gb','United Kingdom','europe','geography_country_gb','["United Kingdom","Reino Unido","Regno Unito","Vereinigtes Königreich","Royaume-Uni"]'),
  ('gb_wls','Wales','europe','geography_country_gb_wls','["Wales","País de Gales","Gales","Galles","Pays de Galles"]'),
  ('as','American Samoa','oceania','geography_country_as','["American Samoa","Samoa Americana","Samoa Americane","Amerikanisch-Samoa","Samoa américaines"]'),
  ('ck','Cook Islands','oceania','geography_country_ck','["Cook Islands","Ilhas Cook","Islas Cook","Isole Cook","Cookinseln","Îles Cook"]'),
  ('fj','Fiji','oceania','geography_country_fj','["Fiji","Fiyi","Figi","Fidschi","Fidji"]'),
  ('pf','French Polynesia','oceania','geography_country_pf','["French Polynesia","Polinésia Francesa","Polinesia Francesa","Polinesia Francese","Französisch-Polynesien","Polynésie française"]'),
  ('ki','Kiribati','oceania','geography_country_ki','["Kiribati"]'),
  ('nc','New Caledonia','oceania','geography_country_nc','["New Caledonia","Nova Caledônia","Nueva Caledonia","Nuova Caledonia","Neukaledonien","Nouvelle-Calédonie"]'),
  ('nz','New Zealand','oceania','geography_country_nz','["New Zealand","Nova Zelândia","Nueva Zelanda","Nuova Zelanda","Neuseeland","Nouvelle-Zélande"]'),
  ('nu','Niue','oceania','geography_country_nu','["Niue"]'),
  ('pg','Papua New Guinea','oceania','geography_country_pg','["Papua New Guinea","Papua-Nova Guiné","Papúa Nueva Guinea","Papua Nuova Guinea","Papua-Neuguinea","Papouasie-Nouvelle-Guinée"]'),
  ('ws','Samoa','oceania','geography_country_ws','["Samoa"]'),
  ('sb','Solomon Islands','oceania','geography_country_sb','["Solomon Islands","Ilhas Salomão","Islas Salomón","Isole Salomone","Salomonen","Îles Salomon"]'),
  ('to','Tonga','oceania','geography_country_to','["Tonga"]'),
  ('tv','Tuvalu','oceania','geography_country_tv','["Tuvalu"]'),
  ('vu','Vanuatu','oceania','geography_country_vu','["Vanuatu"]'),
  ('ar','Argentina','south_america','geography_country_ar','["Argentina","Argentinien","Argentine"]'),
  ('bo','Bolivia','south_america','geography_country_bo','["Bolivia","Bolívia","Bolivien","Bolivie"]'),
  ('br','Brazil','south_america','geography_country_br','["Brazil","Brasil","Brasile","Brasilien","Brésil"]'),
  ('cl','Chile','south_america','geography_country_cl','["Chile","Cile","Chili"]'),
  ('co','Colombia','south_america','geography_country_co','["Colombia","Colômbia","Kolumbien","Colombie"]'),
  ('ec','Ecuador','south_america','geography_country_ec','["Ecuador","Equador","Équateur"]'),
  ('py','Paraguay','south_america','geography_country_py','["Paraguay","Paraguai"]'),
  ('pe','Peru','south_america','geography_country_pe','["Peru","Perú","Perù","Pérou"]'),
  ('uy','Uruguay','south_america','geography_country_uy','["Uruguay","Uruguai"]'),
  ('ve','Venezuela','south_america','geography_country_ve','["Venezuela"]'),
  ('gl','Greenland','','geography_country_gl','["Greenland","Groelândia","Groenlandia","Grönland","Groenland"]')
) AS src(id,name,region_id,message_key,aliases)
LEFT JOIN geography_region r ON r.id=src.region_id
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,region_id=EXCLUDED.region_id,message_key=EXCLUDED.message_key,
  aliases=EXCLUDED.aliases,search_key=EXCLUDED.search_key,region_search_key=EXCLUDED.region_search_key
WHERE (c.name,c.region_id,c.message_key,c.aliases,c.search_key,c.region_search_key) IS DISTINCT FROM
  (EXCLUDED.name,EXCLUDED.region_id,EXCLUDED.message_key,EXCLUDED.aliases,EXCLUDED.search_key,EXCLUDED.region_search_key);

-- Keep previous generated search columns and version views intact.
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team_directory ADD COLUMN IF NOT EXISTS country_id text NOT NULL DEFAULT '';
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team_directory ADD COLUMN IF NOT EXISTS region_id text NOT NULL DEFAULT '';
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team_directory ADD COLUMN IF NOT EXISTS country_search_key text COLLATE golaberto_search NOT NULL DEFAULT '';
-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team_directory ADD COLUMN IF NOT EXISTS region_search_key text COLLATE golaberto_search NOT NULL DEFAULT '';
DO $$ DECLARE col text; BEGIN
  FOREACH col IN ARRAY ARRAY['country_search_key','region_search_key'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='team_directory'::regclass AND attname=col
               AND attcollation <> 'golaberto_search'::regcollation) THEN
      EXECUTE format('ALTER TABLE team_directory ALTER COLUMN %I TYPE text COLLATE golaberto_search',col);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION refresh_team_directory() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET statement_timeout = '20s' AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(70921024) THEN RETURN; END IF;
  WITH selected AS MATERIALIZED (
    SELECT t.id,t.name,t.city,t.country,r.rating,r.measure_date,
      coalesce(c.id,'') AS country_id,coalesce(c.region_id,'') AS region_id,
      coalesce(c.search_key,replace(replace(replace(coalesce(t.country,''),'ı','i'),'þ','th'),'Þ','th')) AS country_search_key,
      coalesce(c.region_search_key,'world mundo mundial monde welt mondo') AS region_search_key
    FROM team t
    LEFT JOIN geography_country c ON c.aliases::jsonb ? t.country
    LEFT JOIN LATERAL (
      SELECT rating,measure_date FROM team_rating WHERE team_id=t.id ORDER BY measure_date DESC,id LIMIT 1
    ) r ON true
  ), removed AS (
    DELETE FROM team_directory d WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id=d.id)
  )
  INSERT INTO team_directory AS d (id,name,city,country,rating,measure_date,country_id,region_id,country_search_key,region_search_key)
    SELECT id,name,city,country,rating,measure_date,country_id,region_id,country_search_key,region_search_key FROM selected ORDER BY id
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,city=EXCLUDED.city,country=EXCLUDED.country,
    rating=EXCLUDED.rating,measure_date=EXCLUDED.measure_date,country_id=EXCLUDED.country_id,region_id=EXCLUDED.region_id,
    country_search_key=EXCLUDED.country_search_key,region_search_key=EXCLUDED.region_search_key
  WHERE (d.name,d.city,d.country,d.rating,d.measure_date,d.country_id,d.region_id,d.country_search_key,d.region_search_key)
    IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.city,EXCLUDED.country,EXCLUDED.rating,EXCLUDED.measure_date,
      EXCLUDED.country_id,EXCLUDED.region_id,EXCLUDED.country_search_key,EXCLUDED.region_search_key);
END;
$$;
REVOKE ALL ON FUNCTION refresh_team_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_team_directory() TO service;
SELECT refresh_team_directory();
NOTIFY pgrst, 'reload schema';
COMMIT;
