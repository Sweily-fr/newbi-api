import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import {
  linkTasks,
  unlinkTasks,
  detachTaskLinks,
  normalizeLinkedTaskIds,
  loadLinkedTaskInfos,
  searchLinkableTasks,
} from "../../src/services/kanbanTaskLinkService.js";

// Le lien entre deux tâches est symétrique : si A est liée à B, B doit être
// liée à A, y compris quand B est sur un autre tableau du même workspace, et
// jamais vers une tâche d'un autre workspace.

const workspaceId = new mongoose.Types.ObjectId();
const otherWorkspaceId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const user = { id: userId.toString(), name: "Alice" };

const makeBoard = async (title, ws = workspaceId) =>
  Board.create({ title, workspaceId: ws, userId });

const makeColumn = async (board, title) =>
  Column.create({
    title,
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: board.workspaceId,
    userId,
  });

const makeTask = async (board, column, title, extra = {}) =>
  Task.create({
    title,
    status: column._id.toString(),
    boardId: board._id,
    columnId: column._id.toString(),
    workspaceId: board.workspaceId,
    userId,
    ...extra,
  });

const linkedIds = async (taskId) =>
  (await Task.findById(taskId).lean()).linkedTasks.map(String);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

describe("normalizeLinkedTaskIds", () => {
  it("garde des ObjectId valides, dédoublonnés, sans la tâche elle-même", () => {
    const self = new mongoose.Types.ObjectId();
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    expect(
      normalizeLinkedTaskIds(
        [a, a.toString(), "pas-un-id", null, self, b],
        self.toString(),
      ),
    ).toEqual([a.toString(), b.toString()]);
    expect(normalizeLinkedTaskIds(undefined)).toEqual([]);
  });
});

describe("linkTasks / unlinkTasks", () => {
  it("pose le lien des deux côtés et journalise l'activité sur les deux tâches", async () => {
    const board = await makeBoard("Projet");
    const col = await makeColumn(board, "À faire");
    const a = await makeTask(board, col, "Tâche A");
    const b = await makeTask(board, col, "Tâche B");

    const { task, linkedTask, changed } = await linkTasks({
      taskId: a._id,
      linkedTaskId: b._id,
      workspaceId,
      user,
      userName: "Alice",
    });

    expect(changed).toBe(true);
    expect(task.linkedTasks.map(String)).toEqual([b._id.toString()]);
    expect(linkedTask.linkedTasks.map(String)).toEqual([a._id.toString()]);
    expect(task.activity.at(-1).description).toBe("a lié la tâche « Tâche B »");
    expect(linkedTask.activity.at(-1).description).toBe(
      "a lié la tâche « Tâche A »",
    );
  });

  it("est idempotent : relier deux fois n'ajoute ni doublon ni activité", async () => {
    const board = await makeBoard("Projet");
    const col = await makeColumn(board, "À faire");
    const a = await makeTask(board, col, "A");
    const b = await makeTask(board, col, "B");

    await linkTasks({ taskId: a._id, linkedTaskId: b._id, workspaceId, user });
    const second = await linkTasks({
      taskId: b._id,
      linkedTaskId: a._id,
      workspaceId,
      user,
    });

    expect(second.changed).toBe(false);
    expect(await linkedIds(a._id)).toEqual([b._id.toString()]);
    expect(await linkedIds(b._id)).toEqual([a._id.toString()]);
    expect((await Task.findById(a._id)).activity).toHaveLength(1);
  });

  it("lie des tâches de deux tableaux différents du même workspace", async () => {
    const board1 = await makeBoard("Tableau 1");
    const board2 = await makeBoard("Tableau 2");
    const col1 = await makeColumn(board1, "À faire");
    const col2 = await makeColumn(board2, "En cours");
    const a = await makeTask(board1, col1, "A");
    const b = await makeTask(board2, col2, "B");

    await linkTasks({ taskId: a._id, linkedTaskId: b._id, workspaceId });

    expect(await linkedIds(a._id)).toEqual([b._id.toString()]);
    expect(await linkedIds(b._id)).toEqual([a._id.toString()]);
  });

  it("refuse une tâche d'un autre workspace et l'auto-liaison", async () => {
    const board = await makeBoard("Projet");
    const otherBoard = await makeBoard("Ailleurs", otherWorkspaceId);
    const col = await makeColumn(board, "À faire");
    const otherCol = await makeColumn(otherBoard, "À faire");
    const a = await makeTask(board, col, "A");
    const foreign = await makeTask(otherBoard, otherCol, "Étrangère");

    await expect(
      linkTasks({ taskId: a._id, linkedTaskId: foreign._id, workspaceId }),
    ).rejects.toThrow("Tâche liée introuvable");
    await expect(
      linkTasks({ taskId: a._id, linkedTaskId: a._id, workspaceId }),
    ).rejects.toThrow("elle-même");
    expect(await linkedIds(a._id)).toEqual([]);
  });

  it("délie des deux côtés", async () => {
    const board = await makeBoard("Projet");
    const col = await makeColumn(board, "À faire");
    const a = await makeTask(board, col, "A");
    const b = await makeTask(board, col, "B");
    const c = await makeTask(board, col, "C");
    await linkTasks({ taskId: a._id, linkedTaskId: b._id, workspaceId });
    await linkTasks({ taskId: a._id, linkedTaskId: c._id, workspaceId });

    // Délier depuis l'autre côté du lien doit fonctionner aussi
    const { changed } = await unlinkTasks({
      taskId: b._id,
      linkedTaskId: a._id,
      workspaceId,
      user,
    });

    expect(changed).toBe(true);
    expect(await linkedIds(a._id)).toEqual([c._id.toString()]);
    expect(await linkedIds(b._id)).toEqual([]);
    expect(await linkedIds(c._id)).toEqual([a._id.toString()]);
  });
});

describe("detachTaskLinks", () => {
  it("retire une tâche supprimée des liens des autres tâches", async () => {
    const board = await makeBoard("Projet");
    const col = await makeColumn(board, "À faire");
    const a = await makeTask(board, col, "A");
    const b = await makeTask(board, col, "B");
    const c = await makeTask(board, col, "C");
    await linkTasks({ taskId: a._id, linkedTaskId: b._id, workspaceId });
    await linkTasks({ taskId: a._id, linkedTaskId: c._id, workspaceId });

    await Task.deleteOne({ _id: a._id });
    const affected = await detachTaskLinks(a._id, workspaceId);

    expect(affected.map((t) => t._id.toString()).sort()).toEqual(
      [b._id.toString(), c._id.toString()].sort(),
    );
    expect(await linkedIds(b._id)).toEqual([]);
    expect(await linkedIds(c._id)).toEqual([]);
  });
});

describe("loadLinkedTaskInfos", () => {
  it("résout titre, tableau et colonne, ignore les liens orphelins, et batch par contexte", async () => {
    const board1 = await makeBoard("Tableau 1");
    const board2 = await makeBoard("Tableau 2");
    const col1 = await makeColumn(board1, "À faire");
    const col2 = await makeColumn(board2, "Terminé");
    const a = await makeTask(board1, col1, "A");
    const b = await makeTask(board2, col2, "B", { priority: "high" });
    const ghost = new mongoose.Types.ObjectId();

    const context = {};
    const [infosA, infosAgain] = await Promise.all([
      loadLinkedTaskInfos(context, [b._id, ghost], workspaceId),
      loadLinkedTaskInfos(context, [b._id, a._id], workspaceId),
    ]);

    expect(infosA).toEqual([
      {
        id: b._id.toString(),
        title: "B",
        boardId: board2._id.toString(),
        boardTitle: "Tableau 2",
        columnId: col2._id.toString(),
        columnTitle: "Terminé",
        status: col2._id.toString(),
        priority: "high",
        dueDate: null,
      },
    ]);
    expect(infosAgain.map((i) => i.title)).toEqual(["B", "A"]);
    // Le cache de contexte a bien été alimenté (une promesse par id demandé)
    expect(context._linkedTaskInfoCache.size).toBe(3);
  });

  it("ne renvoie jamais une tâche d'un autre workspace", async () => {
    const otherBoard = await makeBoard("Ailleurs", otherWorkspaceId);
    const otherCol = await makeColumn(otherBoard, "À faire");
    const foreign = await makeTask(otherBoard, otherCol, "Étrangère");

    expect(await loadLinkedTaskInfos({}, [foreign._id], workspaceId)).toEqual(
      [],
    );
  });
});

describe("searchLinkableTasks", () => {
  it("liste le tableau courant sans recherche, tout le workspace avec, en excluant la tâche", async () => {
    const board1 = await makeBoard("Tableau 1");
    const board2 = await makeBoard("Tableau 2");
    const col1 = await makeColumn(board1, "À faire");
    const col2 = await makeColumn(board2, "À faire");
    const self = await makeTask(board1, col1, "Facture client (moi)", {
      position: 0,
    });
    await makeTask(board1, col1, "Relance facture", { position: 1 });
    await makeTask(board2, col2, "Facture fournisseur");
    await makeTask(board2, col2, "Sans rapport");

    const sameBoard = await searchLinkableTasks({
      workspaceId,
      boardId: board1._id,
      excludeTaskId: self._id,
    });
    expect(sameBoard.map((t) => t.title)).toEqual(["Relance facture"]);

    const everywhere = await searchLinkableTasks({
      workspaceId,
      search: "fact(ure",
      excludeTaskId: self._id,
    });
    expect(everywhere).toEqual([]);

    const found = await searchLinkableTasks({
      workspaceId,
      search: "FACTURE",
      excludeTaskId: self._id,
    });
    expect(found.map((t) => t.title).sort()).toEqual([
      "Facture fournisseur",
      "Relance facture",
    ]);
    expect(found.find((t) => t.title === "Facture fournisseur").boardTitle).toBe(
      "Tableau 2",
    );
  });

  it("ne renvoie rien sans tableau ni recherche", async () => {
    expect(await searchLinkableTasks({ workspaceId })).toEqual([]);
  });
});
