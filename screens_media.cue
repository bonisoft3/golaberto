package golaberto

_mediaPendingMarkup: """
 <details class="community-media"><summary data-text="{msg.media_pending}"></summary>
 <ul data-live="user_pending_upload" data-filter="limit=4" data-order="created_at.asc,id.asc" data-empty="{msg.media_pending_empty}"><template data-item><li>
 <time data-text="{created_at}" data-text-format="datetime"></time>
 <form data-form="media-pending-delete" data-entity="user_pending_upload" data-action="delete">\(_editingFormMessages)<button class="btn-quiet" type="submit" data-text="{msg.media_discard}"></button></form>
 </li></template></ul></details>
 """

#MediaUpload: U={
	field: string
	label: string
	required: *false | bool
	out: """
 <label class="field community-media"><span data-text="{msg.\(U.label)}"></span><input type="file" name="\(U.field)" data-upload accept="image/png,image/jpeg,image/gif"\([if U.required {" required"}, ""][0])><small data-text="{msg.media_formats}"></small></label>
 """
}

_mediaAvatarEditor: """
 <div data-live="community_access" data-select="*,user_avatar(id)" data-filter="kind=eq.profile&record_id=eq.{id}&limit=1" data-empty="">
 <template data-item data-when="avatar_id=is.null"><div class="community-media">
 <form class="edit" data-form="media-avatar-create" data-entity="user_avatar" data-action="create">
 <input type="hidden" name="id" data-value="{record_id}">
 \((#MediaUpload & {field: "avatar_key", label: "media_avatar", required: true}).out)
 \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.media_upload}"></button>
 </form>\(_mediaPendingMarkup)</div></template>
 <template data-item><div class="community-media">
 <div data-live="user_avatar" data-filter="id=eq.{avatar_id}&limit=1" data-empty=""><template data-item><div>
 <form class="edit" data-form="media-avatar-update" data-entity="user_avatar" data-action="update">
 \((#MediaUpload & {field: "avatar_key", label: "media_avatar", required: true}).out)
 \(_editingFormMessages)<button class="btn" type="submit" data-text="{msg.media_upload}"></button></form>
 <form data-form="media-avatar-delete" data-entity="user_avatar" data-action="delete">
 \(_editingFormMessages)<button class="btn-quiet" type="submit" data-text="{msg.media_remove}"></button></form>
 </div></template></div>\(_mediaPendingMarkup)</div></template>
 </div>
 """

_mediaLogoClear: """
 <div class="community-media"><span data-text="{logo_key}" data-text-format="media-image"></span>
 <form data-form="media-logo-clear" data-entity="team" data-action="update">
 <input type="text" hidden name="logo_key" value="" data-value-adapter="editing-text">
 \(_editingFormMessages)<button class="btn-quiet" type="submit" data-text="{msg.media_remove}"></button></form>
 </div>
 """
