package golaberto

code: meta: decisions: "decision-resource-routes": {}

_pageRoutes: {
  "principal": {
    "path": "/"
  },
  "campeonatos": {
    "path": "/campeonatos",
    "slug": "route_championships"
  },
  "campeonato": {
    "path": "/campeonato/:slug",
    "slug": "route_championship"
  },
  "jogos": {
    "path": "/jogos",
    "slug": "route_games"
  },
  "jogo": {
    "path": "/jogo/:slug",
    "slug": "route_game"
  },
  "equipes": {
    "path": "/equipes",
    "slug": "route_teams"
  },
  "equipe": {
    "path": "/equipe/:slug",
    "slug": "route_team"
  },
  "jogadores": {
    "path": "/jogadores",
    "slug": "route_players"
  },
  "jogador": {
    "path": "/jogador/:slug",
    "slug": "route_player"
  },
  "estadios": {
    "path": "/estadios",
    "slug": "route_stadiums"
  },
  "estadio": {
    "path": "/estadio/:slug",
    "slug": "route_stadium"
  },
  "arbitros": {
    "path": "/arbitros",
    "slug": "route_referees"
  },
  "arbitro": {
    "path": "/arbitro/:slug",
    "slug": "route_referee"
  },
  "gerenciar": {
    "path": "/gerenciar",
    "slug": "route_manage"
  },
  "usuarios": {
    "path": "/usuarios",
    "slug": "route_community"
  },
  "usuario": {
    "path": "/usuario/:id",
    "slug": "route_user"
  },
  "arquivo-campeonato": {
    "path": "/campeonato/:slug/jogos",
    "slug": "route_championship",
    "segments": {
      "jogos": "route_games"
    }
  },
  "publico": {
    "path": "/campeonato/:slug/publico",
    "slug": "route_championship",
    "segments": {
      "publico": "route_attendance"
    }
  },
  "campeonato-jogadores": {
    "path": "/campeonato/:slug/jogadores",
    "slug": "route_championship",
    "segments": {
      "jogadores": "route_players"
    }
  },
  "editar-competicao": {
    "path": "/campeonato/:slug/editar",
    "slug": "route_championship",
    "segments": {
      "editar": "route_edit"
    }
  },
  "equipe-campeonato": {
    "path": "/campeonato/:championship/equipe/:slug",
    "slug": "route_championship",
    "segments": {
      "equipe": "route_team"
    }
  },
  "jogador-campeonato": {
    "path": "/campeonato/:championship/equipe/:team/jogador/:slug",
    "slug": "route_championship",
    "segments": {
      "equipe": "route_team",
      "jogador": "route_player"
    }
  },
  "arquivo": {
    "path": "/jogos/arquivo",
    "slug": "route_games",
    "segments": {
      "arquivo": "route_archive"
    }
  },
  "chances": {
    "path": "/grupo/:slug/chances",
    "slug": "route_group",
    "segments": {
      "chances": "route_chances"
    }
  },
  "editar": {
    "path": "/jogo/:slug/placar/editar",
    "slug": "route_game",
    "segments": {
      "placar": "route_score",
      "editar": "route_edit"
    }
  },
  "editar-arbitro": {
    "path": "/arbitro/:slug/editar",
    "slug": "route_referee",
    "segments": {
      "editar": "route_edit"
    }
  },
  "editar-equipe": {
    "path": "/equipe/:slug/editar",
    "slug": "route_team",
    "segments": {
      "editar": "route_edit"
    }
  },
  "editar-estadio": {
    "path": "/estadio/:slug/editar",
    "slug": "route_stadium",
    "segments": {
      "editar": "route_edit"
    }
  },
  "editar-jogador": {
    "path": "/jogador/:slug/editar",
    "slug": "route_player",
    "segments": {
      "editar": "route_edit"
    }
  },
  "editar-jogo": {
    "path": "/jogo/:slug/editar",
    "slug": "route_game",
    "segments": {
      "editar": "route_edit"
    }
  },
  "escalacao-jogo": {
    "path": "/jogo/:slug/escalacao/editar",
    "slug": "route_game",
    "segments": {
      "escalacao": "route_lineup",
      "editar": "route_edit"
    }
  },
  "gols-jogo": {
    "path": "/jogo/:slug/gols/editar",
    "slug": "route_game",
    "segments": {
      "gols": "route_goals",
      "editar": "route_edit"
    }
  },
  "historico-jogo": {
    "path": "/jogo/:slug/historico",
    "slug": "route_game",
    "segments": {
      "historico": "route_history"
    }
  },
  "inscricoes-jogador": {
    "path": "/jogador/:slug/inscricoes/editar",
    "slug": "route_player",
    "segments": {
      "inscricoes": "route_registrations",
      "editar": "route_edit"
    }
  },
  "gerenciar-competicoes": {
    "path": "/gerenciar/campeonatos",
    "slug": "route_manage",
    "segments": {
      "campeonatos": "route_championships"
    }
  },
  "nova-competicao": {
    "path": "/campeonatos/novo",
    "slug": "route_championships",
    "segments": {
      "novo": "route_new"
    }
  },
  "novo-arbitro": {
    "path": "/arbitros/novo",
    "slug": "route_referees",
    "segments": {
      "novo": "route_new"
    }
  },
  "novo-equipe": {
    "path": "/equipes/novo",
    "slug": "route_teams",
    "segments": {
      "novo": "route_new"
    }
  },
  "novo-estadio": {
    "path": "/estadios/novo",
    "slug": "route_stadiums",
    "segments": {
      "novo": "route_new"
    }
  },
  "novo-jogador": {
    "path": "/jogadores/novo",
    "slug": "route_players",
    "segments": {
      "novo": "route_new"
    }
  },
  "novo-jogo": {
    "path": "/jogos/novo",
    "slug": "route_games",
    "segments": {
      "novo": "route_new"
    }
  }
}

code: surface: screens: {
	for name, spec in _pageRoutes {
		(name): {
			route: spec.path
			if spec.slug != _|_ {slug: spec.slug}
			if spec.segments != _|_ {segments: spec.segments}
		}
	}
}
