// One-shot AWS provisioning for the S3 + CloudFront option:
// creates the bucket (private), CORS, an Origin Access Control, and a
// CloudFront distribution, then writes the results back into .env.
// Usage: node scripts/setup-aws.mjs [bucket-name]
// Needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION in .env with
// permissions: s3:CreateBucket/PutBucket*, cloudfront:CreateDistribution/
// CreateOriginAccessControl, sts:GetCallerIdentity.
import "dotenv/config";
import fs from "node:fs";
import {
  S3Client, CreateBucketCommand, PutPublicAccessBlockCommand,
  PutBucketPolicyCommand, HeadBucketCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient, CreateOriginAccessControlCommand, CreateDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { putBucketCorsOpen } from "../lib/providers.mjs";

const region = process.env.AWS_REGION || "ap-south-1";
const bucket = process.argv[2] || process.env.S3_BUCKET || `ai-lms-videos-${Date.now().toString(36)}`;
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error("Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env.");
  process.exit(1);
}

// Managed policy IDs (AWS-global constants):
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const SIMPLE_CORS = "60669652-455b-4ae9-85a4-c4c02393f86c";

const s3 = new S3Client({ region });
const cf = new CloudFrontClient({ region: "us-east-1" }); // CloudFront is global
const sts = new STSClient({ region });

const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}));
console.log(`AWS account ${accountId}, region ${region}`);

// 1. Bucket (private, all public access blocked — CloudFront reads via OAC).
try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`Bucket ${bucket} already exists — reusing.`);
} catch {
  await s3.send(new CreateBucketCommand({
    Bucket: bucket,
    ...(region !== "us-east-1" && {
      CreateBucketConfiguration: { LocationConstraint: region },
    }),
  }));
  console.log(`Created bucket ${bucket}`);
}
await s3.send(new PutPublicAccessBlockCommand({
  Bucket: bucket,
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true, IgnorePublicAcls: true,
    BlockPublicPolicy: false, RestrictPublicBuckets: false,
  },
}));
await putBucketCorsOpen(s3, bucket);
console.log("Bucket locked down + CORS set.");

// 2. Origin Access Control.
const oac = await cf.send(new CreateOriginAccessControlCommand({
  OriginAccessControlConfig: {
    Name: `${bucket}-oac-${Date.now().toString(36)}`,
    OriginAccessControlOriginType: "s3",
    SigningBehavior: "always",
    SigningProtocol: "sigv4",
  },
}));
console.log(`Created OAC ${oac.OriginAccessControl.Id}`);

// 3. Distribution.
const originDomain = `${bucket}.s3.${region}.amazonaws.com`;
const dist = await cf.send(new CreateDistributionCommand({
  DistributionConfig: {
    CallerReference: `ai-lms-${Date.now()}`,
    Comment: "AI LMS video PoC",
    Enabled: true,
    PriceClass: "PriceClass_200", // includes India + Asia + US + EU
    Origins: {
      Quantity: 1,
      Items: [{
        Id: "s3-origin",
        DomainName: originDomain,
        OriginAccessControlId: oac.OriginAccessControl.Id,
        S3OriginConfig: { OriginAccessIdentity: "" },
      }],
    },
    DefaultCacheBehavior: {
      TargetOriginId: "s3-origin",
      ViewerProtocolPolicy: "redirect-to-https",
      Compress: true,
      CachePolicyId: CACHING_OPTIMIZED,
      ResponseHeadersPolicyId: SIMPLE_CORS,
      AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
    },
  },
}));
const domain = dist.Distribution.DomainName;
const distArn = dist.Distribution.ARN;
console.log(`Created distribution ${dist.Distribution.Id} -> https://${domain}`);

// 4. Bucket policy: only this distribution may read.
await s3.send(new PutBucketPolicyCommand({
  Bucket: bucket,
  Policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowCloudFrontOAC",
      Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:GetObject",
      Resource: `arn:aws:s3:::${bucket}/*`,
      Condition: { StringEquals: { "AWS:SourceArn": distArn } },
    }],
  }),
}));
console.log("Bucket policy attached (CloudFront-only reads).");

// 5. Persist to .env.
const envPath = ".env";
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
for (const [k, v] of [["S3_BUCKET", bucket], ["CLOUDFRONT_URL", `https://${domain}`], ["AWS_REGION", region]]) {
  const line = `${k}=${v}`;
  env = new RegExp(`^${k}=`, "m").test(env)
    ? env.replace(new RegExp(`^${k}=.*$`, "m"), line)
    : env + (env.endsWith("\n") || env === "" ? "" : "\n") + line + "\n";
}
fs.writeFileSync(envPath, env);
console.log(`\n.env updated: S3_BUCKET=${bucket}, CLOUDFRONT_URL=https://${domain}`);
console.log("Note: the distribution takes ~5-10 min to deploy before URLs work.");
