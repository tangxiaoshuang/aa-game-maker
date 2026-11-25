import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface S3StorageConfig {
  endpoint: string;
  publicBaseUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketAssets: string;
  bucketReleases: string;
}

export class ObjectStorageService {
  readonly config: S3StorageConfig;
  private readonly client: S3Client;
  private available = false;

  constructor(partial?: Partial<S3StorageConfig>) {
    const endpoint = partial?.endpoint ?? process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
    this.config = {
      endpoint,
      publicBaseUrl: partial?.publicBaseUrl ?? process.env.S3_PUBLIC_URL ?? endpoint,
      region: partial?.region ?? process.env.S3_REGION ?? "us-east-1",
      accessKeyId: partial?.accessKeyId ?? process.env.S3_ACCESS_KEY ?? "aagameadmin",
      secretAccessKey: partial?.secretAccessKey ?? process.env.S3_SECRET_KEY ?? "aagame_s3_dev_password",
      bucketAssets: partial?.bucketAssets ?? process.env.S3_BUCKET_ASSETS ?? "aa-game-assets",
      bucketReleases: partial?.bucketReleases ?? process.env.S3_BUCKET_RELEASES ?? "aa-game-releases",
    };

    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  isAvailable(): boolean {
    return this.available;
  }

  async ensureBuckets(): Promise<boolean> {
    try {
      for (const bucket of [this.config.bucketAssets, this.config.bucketReleases]) {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch {
          await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
        }
        // Enable anonymous read so browser games & gallery covers can load directly from RustFS S3
        const policy = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: ["*"] },
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${bucket}/*`],
            },
          ],
        });
        await this.client
          .send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }))
          .catch(() => {});
      }
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  async putObject(params: {
    bucket: "assets" | "releases";
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<{ url: string; storage: "s3" } | null> {
    if (!this.available) {
      await this.ensureBuckets();
    }
    if (!this.available) return null;

    const bucketName =
      params.bucket === "assets" ? this.config.bucketAssets : this.config.bucketReleases;
    const bodyBuf = typeof params.body === "string" ? Buffer.from(params.body, "utf8") : params.body;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: params.key,
          Body: bodyBuf,
          ContentType: params.contentType,
        }),
      );
      const base = this.config.publicBaseUrl.replace(/\/+$/, "");
      return {
        url: `${base}/${bucketName}/${params.key}`,
        storage: "s3",
      };
    } catch {
      return null;
    }
  }
}
