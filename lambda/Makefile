# sam build（BuildMethod: makefile）から呼ばれる。手で実行するものではない。
# バンドルは npm run bundle（scripts/bundle.mjs）が作る。理由はそのファイルの冒頭を参照。
#
# ★ レシピの行頭はタブ文字であること（スペースだと make が失敗する）。

build-ApiFunction:
	npm run bundle
	cp dist/index.cjs dist/index.cjs.map "$(ARTIFACTS_DIR)/"
