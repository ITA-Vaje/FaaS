/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const express = require("express");
const app = express();
app.use(express.json());


admin.initializeApp();

const db = admin.firestore();

exports.registerUser = onRequest(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).send("Email and password are required.");
    return;
  }

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password,
    });
    res.status(201).send({ message: "User created", uid: userRecord.uid });
  } catch (error) {
    logger.error("Error creating user:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.submitPrediction = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

//   const idToken = req.headers.authorization?.split("Bearer ")[1];
//   if (!idToken) {
//     return res.status(401).send("Missing auth token");
//   }

  try {
    // const decodedToken = await admin.auth().verifyIdToken(idToken);
    // const uid = decodedToken.uid;
    const uid = "test-user-123"; // fake user ID
    const { raceId, prediction } = req.body;

    if (!raceId || !prediction || !prediction.p1 || !prediction.p2 || !prediction.p3) {
      return res.status(400).send("Missing raceId or prediction (p1, p2, p3)");
    }

    const docId = `${raceId}_${uid}`;

    await db.collection("predictions").add({
    uid,
    raceId,
    prediction,
    timestamp: new Date().toISOString()
    });

    res.status(200).send({ message: "Prediction submitted successfully" });
  } catch (error) {
    logger.error("Error submitting prediction:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.updateRaceResult = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { raceId, result } = req.body;

  if (!raceId || !result || !result.p1 || !result.p2 || !result.p3) {
    return res.status(400).send("Missing raceId or result (p1, p2, p3)");
  }

  try {
    await admin.firestore().collection("results").doc(raceId).set({
      result,
      timestamp: new Date().toISOString(),
    });

    res.status(200).send({ message: "Race result updated" });
  } catch (error) {
    logger.error("Error updating race result:", error);
    res.status(500).send({ error: error.message });
  }
});


