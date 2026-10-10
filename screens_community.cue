package golaberto

#CommunityBiographyForm: F={
	action: string
	out:    """
 <form class="edit" data-form="community-biography-\(F.action)" data-entity="user_biography" data-action="\(F.action)">
 <div class="fields">
 \((#EditingField & {name: "display_name", label: "community_name", max: 100, current: F.action == "update"}).out)
 \((#EditingField & {name: "location", label: "community_location", max: 100, current: F.action == "update"}).out)
 </div>
 <label class="field"><span data-text="{msg.community_about}"></span><textarea name="about_me" rows="6" maxlength="2000" data-value-adapter="editing-text"\([if F.action == "update" {" data-value=\"{about_me}\""}, ""][0])></textarea></label>
 \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.edit_save}"></button>
 </form>
 """
}

_communityProfileEditor: """
 <div data-live="community_access" data-select="*,user_biography(id)" data-filter="kind=eq.profile&record_id=eq.{id}&limit=1" data-empty="">
 <template data-item data-when="biography_id=is.null"><details class="community-edit"><summary data-text="{msg.community_edit}"></summary>
 \((#CommunityBiographyForm & {action: "create"}).out)
 </details></template>
 <template data-item><details class="community-edit"><summary data-text="{msg.community_edit}"></summary>
 <div data-live="user_biography" data-filter="id=eq.{biography_id}&limit=1" data-empty=""><template data-item><div>
 \((#CommunityBiographyForm & {action: "update"}).out)
 </div></template></div>
 </details></template></div>
 """

#CommunityCommentDelete: D={
	table: string
	out:   """
 <div data-live="community_access" data-filter="kind=eq.\(D.table)&record_id=eq.{id}&limit=1" data-empty=""><template data-item>
 <details class="community-comment-delete"><summary data-text="{msg.community_delete_comment}"></summary>
 <form data-form="community-\(D.table)-delete" data-entity="\(D.table)" data-action="delete" data-filter="id=eq.{record_id}">
 <label class="field"><input type="checkbox" required><span data-text="{msg.community_confirm_delete}"></span></label>
 \(_editingFormMessages)<button class="btn-quiet" type="submit" data-text="{msg.manage_remove}"></button>
 </form></details></template></div>
 """
}

#CommunityHistory: H={
	key:    string
	filter: string
	owner:  *"{id}" | string
	out: (#PagedRead & {
		key:     H.key, table: "game_change", owner: H.owner, filter: H.filter, order: "created_at.desc,id.asc"
		content: """
 <ol class="community-history" data-live="game_change" data-filter="\(H.filter)&offset={offset}&limit=40" data-order="created_at.desc,id.asc" data-empty="{msg.community_history_empty}"><template data-item><li>
 <p><b data-text="{championship_name}"></b> · <span data-text="{game_day}"></span></p>
 <p><a data-route="jogo" data-param-slug="{game_slug}"><span data-text="{home_name}"></span> × <span data-text="{away_name}"></span></a></p>
 <p class="byline"><span data-text="{msg.community_version}"></span> <b data-text="{version}"></b> · <time data-text="{created_at}" data-text-format="datetime"></time>
 <a data-route="usuario" data-param-id="{actor_id}" data-text="{actor_handle}"></a></p>
 <div data-text="{changes_json}\u001f{msg.community_unknown}\u001f{msg.community_before}\u001f{msg.community_after}\u001f{msg.community_field_phase_id}\u001f{msg.community_field_round}\u001f{msg.community_field_day}\u001f{msg.community_field_kickoff}\u001f{msg.community_field_home_id}\u001f{msg.community_field_away_id}\u001f{msg.community_field_home_field}\u001f{msg.community_field_played}\u001f{msg.community_field_home_score}\u001f{msg.community_field_away_score}\u001f{msg.community_field_home_aet}\u001f{msg.community_field_away_aet}\u001f{msg.community_field_home_pen}\u001f{msg.community_field_away_pen}\u001f{msg.community_field_stadium_id}\u001f{msg.community_field_referee_id}\u001f{msg.community_field_attendance}\u001f{msg.manage_home_advantage}\u001f{msg.manage_neutral}\u001f{msg.manage_away_advantage}\u001f{msg.community_yes}\u001f{msg.community_no}" data-text-format="community-history"></div>
 </li></template></ol>
 """
	}).out
}

_communityDirectoryMarkup: """
 <section class="screen" data-screen="usuarios">
 \((#Masthead & {route: "usuarios"}).out)
 <h1 class="band" data-text="{msg.community_title}"></h1>
 <div class="page"><div class="content">
 \((#PagedRead & {
	key: "community-users", owner: "00000000-0000-0000-0000-000000000000", table: "user_directory", filter: "search_key=like.*{q_key}*", order: "display_name.asc,id.asc"
	context: {q: "", q_key: ""}
	events: {"input@community-users-q": assign: {q: {type: "event", params: field: "value"}, q_key: {type: "search-key"}, offset: 0, next_offset: 40, page: 1}}
	controls: "<label class=\"field\"><span data-text=\"{msg.community_search}\"></span><input id=\"community-users-q\" type=\"search\" value=\"{q}\" maxlength=\"80\"></label>"
	content: """
		<ul class="community-list" data-live="user_directory" data-filter="search_key=like.*{q_key}*&offset={offset}&limit=40" data-order="display_name.asc,id.asc" data-empty="{msg.community_empty}"><template data-item><li>
		<span class="archive-icon" data-text="{avatar_key}|thumb" data-text-format="media-image"></span><a data-route="usuario" data-param-id="{id}" data-text="{display_name}"></a>
		<p class="community-counts"><span><b data-text="{comment_count}" data-text-format="number"></b> <span data-text="{msg.community_comments}"></span></span><span><b data-text="{edit_count}" data-text-format="number"></b> <span data-text="{msg.community_edits}"></span></span></p>
		</li></template></ul>
		"""
}).out)
 </div></div></section>
 """

_communityProfileMarkup: """
 <section class="screen" data-screen="usuario">
 \((#Masthead & {route: "usuario", params: " data-param-id=\"{param.id}\""}).out)
 <div data-live="user_directory" data-select="*,user_biography(id)" data-filter="id=eq.{param.id}&limit=1" data-empty="{msg.community_gone}"><template data-item><article>
 <h1 class="band" data-text="{display_name}"></h1>
 <div data-live="user_avatar" data-filter="id=eq.{id}&limit=1" data-empty=""><template data-item><div class="community-avatar" data-text="{avatar_key}" data-text-format="media-image"></div></template></div>
 <div class="page"><div class="content">
 <a class="btn-quiet" data-route="usuarios" data-text="{msg.community_title}"></a>
 <dl class="community-facts"><div><dt data-text="{msg.community_handle}"></dt><dd data-text="{handle}"></dd></div><div><dt data-text="{msg.community_joined}"></dt><dd data-text="{joined_on}"></dd></div><div><dt data-text="{msg.community_location}"></dt><dd data-text="{location}"></dd></div></dl>
 <p class="community-about" data-text="{about_me}"></p>
 <p class="community-counts"><span><b data-text="{comment_count}" data-text-format="number"></b> <span data-text="{msg.community_comments}"></span></span><span><b data-text="{edit_count}" data-text-format="number"></b> <span data-text="{msg.community_edits}"></span></span></p>
 <p class="editing-success" role="status" data-text="{msg.manage_saved}"></p>
 \(_communityProfileEditor)
 \(_mediaAvatarEditor)
 <h2 data-text="{msg.community_profile_edits}"></h2>
 \((#CommunityHistory & {key: "community-user-history", filter: "actor_id=eq.{owner_id}"}).out)
 </div></div></article></template></div></section>
 """

_communityGameHistoryMarkup: """
 <section class="screen" data-screen="historico-jogo">
 \((#Masthead & {route: "historico-jogo", params: " data-param-slug=\"{param.slug}\""}).out)
 <h1 class="band" data-text="{msg.community_history}"></h1>
 <div class="page"><div class="content">
 <a class="btn-quiet" data-route="jogo" data-param-slug="{param.slug}" data-text="{msg.community_back_game}"></a>
 <div data-live="game" data-filter="slug=eq.{param.slug}&limit=1" data-empty="{msg.game_gone}"><template data-item>
 <div class="community-game-history">
 \((#CommunityHistory & {key: "community-game-history", filter: "game_id=eq.{owner_id}"}).out)
 </div>
 </template></div>
 </div></div></section>
 """
