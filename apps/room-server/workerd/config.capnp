using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "supervisor",
      worker = (
        compatibilityDate = "2025-09-01",
        compatibilityFlags = ["experimental"],
        modules = [
          (name = "supervisor.mjs", esModule = embed "supervisor.mjs")
        ],
        bindings = [
          (name = "LOADER", workerLoader = ())
        ]
      )
    )
  ],
  sockets = [
    (
      name = "http",
      address = "127.0.0.1:4001",
      http = (),
      service = "supervisor"
    )
  ]
);
