// models/kanbanTemplate.js
import mongoose from 'mongoose';

const templateTagSchema = new mongoose.Schema({
  name: String,
  className: String,
  bg: String,
  text: String,
  border: String
}, { _id: false });

const templateChecklistItemSchema = new mongoose.Schema({
  text: String,
  completed: { type: Boolean, default: false }
}, { _id: false });

const templateColumnSchema = new mongoose.Schema({
  title: { type: String, required: true },
  color: { type: String, required: true },
  order: { type: Number, required: true }
}, { _id: false });

const templateTaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', '']
  },
  tags: [templateTagSchema],
  checklist: [templateChecklistItemSchema],
  position: { type: Number, default: 0 },
  columnIndex: { type: Number, required: true }
}, { _id: false });

const kanbanTemplateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Le nom du template est requis'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  columns: [templateColumnSchema],
  tasks: [templateTaskSchema],
  sourceBoardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board'
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

kanbanTemplateSchema.index({ workspaceId: 1, createdAt: -1 });

const KanbanTemplate = mongoose.model('KanbanTemplate', kanbanTemplateSchema);

export default KanbanTemplate;
