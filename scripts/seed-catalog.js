// Loads a starter service catalog and a default tariff so you can try the billing flow: npm run seed:catalog
// !! The prices below are SAMPLE values for development. Replace them with your hospital's real tariff
//    (PUT /api/v1/tariffs/:id/prices) before using real data. Safe to re-run: existing codes are skipped.
import { connectDB, disconnectDB } from "../src/config/db.js";
import { Service } from "../src/models/Service.js";
import { Tariff } from "../src/models/Tariff.js";
import { TariffItem } from "../src/models/TariffItem.js";

// [code, name, department, category, sample price in NAIRA]
const CATALOG = [
  ["CONS-GEN", "General consultation", "consultation", "consultation", 5000],
  [
    "CONS-SPEC",
    "Specialist consultation",
    "consultation",
    "consultation",
    10000,
  ],
  ["LAB-MP", "Malaria parasite test", "laboratory", "lab-test", 2500],
  ["LAB-FBC", "Full blood count", "laboratory", "lab-test", 4000],
  ["LAB-URI", "Urinalysis", "laboratory", "lab-test", 2000],
  ["RAD-CXR", "Chest X-ray", "radiology", "imaging", 12000],
  ["RAD-USS", "Abdominal ultrasound", "radiology", "imaging", 15000],
  ["PHA-PARA", "Paracetamol 500mg (pack)", "pharmacy", "drug", 500],
  ["PHA-AMOX", "Amoxicillin 500mg (course)", "pharmacy", "drug", 3500],
  ["PRO-DRESS", "Wound dressing", "procedure", "procedure", 3500],
  ["PRO-INJ", "Injection administration", "procedure", "procedure", 1000],
  ["WARD-BED", "Ward bed (per day)", "ward", "accommodation", 15000],
];

await connectDB();
const now = new Date();

let tariff = await Tariff.findOne({ isDefault: true });
if (!tariff) {
  tariff = await Tariff.create({
    code: "STANDARD",
    name: "Standard tariff",
    description: "Default price list",
    isDefault: true,
  });
  console.log("Created default tariff STANDARD");
} else {
  console.log(`Using existing default tariff ${tariff.code}`);
}

let created = 0;
for (const [code, name, department, category, naira] of CATALOG) {
  let svc = await Service.findOne({ code });
  if (!svc) {
    svc = await Service.create({ code, name, department, category });
    created++;
  }
  const hasPrice = await TariffItem.exists({
    tariffId: tariff._id,
    serviceId: svc._id,
    isCurrent: true,
  });
  if (!hasPrice)
    await TariffItem.create({
      tariffId: tariff._id,
      serviceId: svc._id,
      priceKobo: naira * 100,
      effectiveFrom: now,
    });
}
console.log(
  `Catalog ready: ${created} new services. Prices are SAMPLE values; replace them with your real tariff.`,
);
await disconnectDB();
