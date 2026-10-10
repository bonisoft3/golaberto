package golaberto

code: state: entities: {
	UserAvatar: {
		id: "0xc9e073141b743ef7"
		table:      "user_avatar"
		durability: "server"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "app_user", default: "auth_uid()"},
			{ordinal: 2, name: "avatar_key", type: "string", required: false},
		]
	}
	UserPendingUpload: {
		id: "0xa102210ba975f47a"
		table:      "user_pending_upload"
		durability: "server"
		access: {scope: "private", owner: "app_user_id"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "app_user_id", type: "uuid", ref: "app_user"},
			{ordinal: 3, name: "created_at", type: "timestamp"},
			{ordinal: 4, name: "expires_at", type: "timestamp"},
		]
	}
}
