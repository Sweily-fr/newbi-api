// resolvers/kanbanTemplate.js
import { Board, Column, Task } from "../models/kanban.js";
import KanbanTemplate from "../models/kanbanTemplate.js";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import { getPubSub } from "../config/redis.js";
import logger from "../utils/logger.js";

const BOARD_UPDATED = "BOARD_UPDATED";

const safePublish = (channel, payload, context = "") => {
  try {
    const pubsub = getPubSub();
    pubsub.publish(channel, payload).catch((error) => {
      logger.error(`[KanbanTemplate] Erreur publication ${context}:`, error);
    });
  } catch (error) {
    logger.error(`[KanbanTemplate] Erreur getPubSub ${context}:`, error);
  }
};

const kanbanTemplateResolvers = {
  Query: {
    kanbanTemplates: withWorkspace(
      async (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        return KanbanTemplate.find({ workspaceId: finalWorkspaceId }).sort({ createdAt: -1 });
      }
    ),
  },

  Mutation: {
    saveBoardAsTemplate: withWorkspace(
      async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { boardId, name, description } = input;

        const board = await Board.findOne({ _id: boardId, workspaceId: finalWorkspaceId });
        if (!board) throw new Error("Board not found");

        const columns = await Column.find({ boardId, workspaceId: finalWorkspaceId }).sort({ order: 1 });
        const tasks = await Task.find({ boardId, workspaceId: finalWorkspaceId }).sort({ position: 1 });

        // Build column index map: columnId -> index
        const columnIndexMap = {};
        const templateColumns = columns.map((col, index) => {
          columnIndexMap[col._id.toString()] = index;
          return {
            title: col.title,
            color: col.color,
            order: index,
          };
        });

        // Build template tasks mapped to columnIndex
        const templateTasks = tasks.map((task) => ({
          title: task.title,
          description: task.description || "",
          priority: task.priority || "",
          tags: (task.tags || []).map((t) => ({
            name: t.name,
            className: t.className,
            bg: t.bg,
            text: t.text,
            border: t.border,
          })),
          checklist: (task.checklist || []).map((c) => ({
            text: c.text,
            completed: c.completed || false,
          })),
          position: task.position || 0,
          columnIndex: columnIndexMap[task.columnId] ?? 0,
        }));

        const template = new KanbanTemplate({
          name,
          description: description || "",
          columns: templateColumns,
          tasks: templateTasks,
          sourceBoardId: boardId,
          workspaceId: finalWorkspaceId,
          userId: user.id,
        });

        const saved = await template.save();
        logger.info(`[KanbanTemplate] Template "${name}" created from board ${boardId}`);
        return saved;
      }
    ),

    createBoardFromTemplate: withWorkspace(
      async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { title, description, templateId } = input;

        const template = await KanbanTemplate.findOne({ _id: templateId, workspaceId: finalWorkspaceId });
        if (!template) throw new Error("Template not found");

        // Create the board
        const board = new Board({
          title,
          description: description || "",
          userId: user.id,
          workspaceId: finalWorkspaceId,
        });
        const savedBoard = await board.save();

        // Create columns from template and build index -> columnId map
        const columnIdMap = {};
        for (const col of template.columns) {
          const column = new Column({
            title: col.title,
            color: col.color,
            order: col.order,
            boardId: savedBoard._id,
            userId: user.id,
            workspaceId: finalWorkspaceId,
          });
          const savedColumn = await column.save();
          columnIdMap[col.order] = savedColumn._id.toString();
        }

        // Create tasks from template
        for (const t of template.tasks) {
          const columnId = columnIdMap[t.columnIndex];
          if (!columnId) continue;

          const task = new Task({
            title: t.title,
            description: t.description || "",
            status: "active",
            priority: t.priority || "",
            tags: t.tags || [],
            checklist: (t.checklist || []).map((c) => ({
              text: c.text,
              completed: c.completed || false,
            })),
            position: t.position || 0,
            boardId: savedBoard._id,
            columnId,
            userId: user.id,
            workspaceId: finalWorkspaceId,
          });
          await task.save();
        }

        // Publish real-time event
        safePublish(
          `${BOARD_UPDATED}_${finalWorkspaceId}`,
          {
            type: "CREATED",
            board: savedBoard,
            workspaceId: finalWorkspaceId,
          },
          "Board created from template"
        );

        logger.info(`[KanbanTemplate] Board "${title}" created from template ${templateId}`);
        return savedBoard;
      }
    ),

    deleteKanbanTemplate: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const result = await KanbanTemplate.findOneAndDelete({ _id: id, workspaceId: finalWorkspaceId });
        if (!result) throw new Error("Template not found");
        logger.info(`[KanbanTemplate] Template ${id} deleted`);
        return true;
      }
    ),
  },
};

export default kanbanTemplateResolvers;
