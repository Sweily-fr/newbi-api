require('dotenv').config();
const AWS = require('aws-sdk');

async function testAWSFormat() {
  console.log('🧪 Test avec format AWS standard\n');
  
  // Debug des variables
  console.log('🔑 Variables chargées:');
  console.log('- AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID?.substring(0, 8) + '...');
  console.log('- AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY?.substring(0, 8) + '...');
  console.log('- AWS_S3_BUCKET_NAME:', process.env.AWS_S3_BUCKET_NAME);
  console.log('- AWS_S3_API_URL:', process.env.AWS_S3_API_URL);
  console.log();

  // Configuration S3
  const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: 'https://157ce0fed50fe542bc92a07317a09205.r2.cloudflarestorage.com',
    region: 'auto',
    s3ForcePathStyle: true,
    signatureVersion: 'v4'
  });

  console.log('📋 Test 1: Liste des buckets...');
  try {
    const buckets = await s3.listBuckets().promise();
    console.log('✅ Connexion réussie !');
    console.log('📦 Buckets trouvés:', buckets.Buckets?.map(b => b.Name) || []);
    
    // Test sur le bucket spécifique
    console.log('\n📋 Test 2: Contenu du bucket image-signature...');
    const objects = await s3.listObjectsV2({
      Bucket: 'image-signature',
      MaxKeys: 5
    }).promise();
    
    console.log(`✅ Bucket accessible ! ${objects.Contents?.length || 0} objets trouvés`);
    
  } catch (error) {
    console.log('❌ Erreur:', error.message);
    console.log('Code:', error.code);
    console.log('Status:', error.statusCode);
    
    if (error.statusCode === 401) {
      console.log('🔑 Problème d\'authentification - vérifiez vos nouvelles clés !');
    }
  }
}

testAWSFormat();
