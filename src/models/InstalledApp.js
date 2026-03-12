import mongoose from "mongoose";

const installedAppSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    appId: {
      type: String,
      required: true,
      trim: true,
    },
    installedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
  },
  { timestamps: true }
);

// Une app ne peut être installée qu'une fois par organisation
installedAppSchema.index({ organizationId: 1, appId: 1 }, { unique: true });

const InstalledApp = mongoose.model("InstalledApp", installedAppSchema);

export default InstalledApp;
