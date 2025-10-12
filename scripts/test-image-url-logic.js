/**
 * Script de test pour vérifier la logique de génération d'URL d'images
 */

// Simuler les variables d'environnement de production
process.env.AWS_S3_API_URL_PROFILE = "https://pub-012a0ee1541743df9b78b220e9efac5e.r2.dev";
process.env.COMPANY_IMAGES_PUBLIC_URL = "https://pub-19b808e3d50f470986cbcd49d62e0d54.r2.dev";
process.env.IMAGE_OCR_PUBLIC_URL = "https://pub-21ee13d6fd6641b386ecb341da204997.r2.dev";
process.env.IMAGE_PUBLIC_URL = "https://pub-e2f65bd10e4e4c9dbfb9ccad034abd75.r2.dev";
process.env.AWS_R2_PUBLIC_URL = "https://pub-483bac77717f4e85b5c7a7962a521a1f.r2.dev";

// Fonction de test simplifiée basée sur la logique du service
function testImageUrlLogic(key) {
  console.log(`\n🔍 Test pour la clé: ${key}`);
  
  let targetPublicUrl = process.env.AWS_R2_PUBLIC_URL;
  const keyParts = key.split("/");
  
  if (keyParts.length >= 2 && keyParts[1] === "image") {
    // Format: userId/image/filename -> Image de profil
    targetPublicUrl = process.env.AWS_S3_API_URL_PROFILE;
    console.log('👤 Image de profil détectée');
  } else if (keyParts.length >= 2 && keyParts[1] === "company") {
    // Format: userId/company/filename -> Image d'entreprise
    targetPublicUrl = process.env.COMPANY_IMAGES_PUBLIC_URL;
    console.log('🏢 Image d\'entreprise détectée');
  } else if (keyParts.length >= 1 && !key.includes("signatures")) {
    // Format: orgId/filename -> Image OCR
    targetPublicUrl = process.env.IMAGE_OCR_PUBLIC_URL;
    console.log('📄 Image OCR détectée');
  } else if (key.includes("signatures")) {
    // Format signatures/userId/type/filename -> Image signature
    targetPublicUrl = process.env.IMAGE_PUBLIC_URL;
    console.log('✍️ Image signature détectée');
  }
  
  const finalUrl = `${targetPublicUrl}/${key}`;
  console.log(`🌐 URL finale: ${finalUrl}`);
  
  return finalUrl;
}

// Tests avec différents types d'images
console.log('=== Test de la logique de génération d\'URL d\'images ===');

// Test 1: Image de profil (votre cas)
testImageUrlLogic('68cd422bae6d99144724d8b6/image/03d34e29-0f43-465d-b6eb-a7ca6ecc06b1.png');

// Test 2: Image d'entreprise
testImageUrlLogic('68cd422bae6d99144724d8b6/company/logo-company.png');

// Test 3: Image OCR
testImageUrlLogic('orgId123/receipt-scan.jpg');

// Test 4: Image signature
testImageUrlLogic('signatures/userId123/profile/signature.png');

console.log('\n✅ Tests terminés');
