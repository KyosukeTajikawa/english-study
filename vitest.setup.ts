import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * フロントのテスト共通の初期設定。
 *
 * - jest-dom: toBeInTheDocument() などの DOM 向けマッチャーを使えるようにする
 * - cleanup: テストごとに描画した DOM を片付ける。globals: true にしていないため
 *   Testing Library の自動クリーンアップが働かず、明示的に呼ぶ必要がある
 */
afterEach(() => {
  cleanup();
});
