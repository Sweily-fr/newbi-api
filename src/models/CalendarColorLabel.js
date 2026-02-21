import mongoose from 'mongoose';

const colorLabelEntrySchema = new mongoose.Schema({
  color: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    required: true,
    trim: true,
    maxlength: 30,
  },
}, { _id: false });

const calendarColorLabelSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true,
  },
  labels: {
    type: [colorLabelEntrySchema],
    validate: {
      validator: (v) => v.length >= 1 && v.length <= 20,
      message: 'Entre 1 et 20 étiquettes de couleur sont autorisées.',
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

calendarColorLabelSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

calendarColorLabelSchema.index({ workspaceId: 1 });

const CalendarColorLabel = mongoose.model('CalendarColorLabel', calendarColorLabelSchema);

export default CalendarColorLabel;
