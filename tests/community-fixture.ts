export const identity = (id: string, guest: boolean | null = false) =>
	`RESET ROLE;
  SET LOCAL app.scopes='public:,user:${id}';
  SET LOCAL request.jwt.claims='{"sub":"${id}"${
		guest === null ? "" : `,"guest":${guest}`
	}}';
  SET LOCAL ROLE app_user;`;

export function fixture() {
	const [
		actor,
		other,
		reader,
		legacy,
		home,
		away,
		champ,
		phase,
		game,
		biography,
		comment,
		teamComment,
	] = Array.from({ length: 12 }, () => crypto.randomUUID());
	const setup = `INSERT INTO app_user(id,handle) VALUES
      ('${actor}','actor-${actor}'),('${other}','other-${other}'),
      ('${reader}','reader-${reader}'),('${legacy}','legacy-${legacy}');
    INSERT INTO editor(app_user_id) VALUES ('${actor}'),('${other}');
    INSERT INTO team(id,name,country) VALUES ('${home}','Community home','Brasil'),('${away}','Community away','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends)
      VALUES ('${champ}','Community season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Community phase');
    INSERT INTO game(id,phase_id,day,home_id,away_id,played,home_score,away_score)
      VALUES ('${game}','${phase}','2026-01-02','${home}','${away}',true,0,0);
    INSERT INTO user_biography(id,app_user_id,display_name,location,about_me)
      VALUES ('${biography}','${legacy}','Legacy biography','Curitiba','Imported public biography');
    INSERT INTO comment(id,game_id,app_user_id,body) VALUES ('${comment}','${game}','${actor}','Match comment');
    INSERT INTO team_comment(id,team_id,app_user_id,body) VALUES ('${teamComment}','${home}','${actor}','Team comment');`;
	return {
		actor,
		other,
		reader,
		legacy,
		home,
		away,
		champ,
		phase,
		game,
		biography,
		comment,
		teamComment,
		setup,
	};
}
