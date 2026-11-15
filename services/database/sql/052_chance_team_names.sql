UPDATE public.team_chance AS chance
SET team_name = team.name
FROM public.team AS team
WHERE chance.team_id = team.id
  AND chance.team_name IS DISTINCT FROM team.name;
