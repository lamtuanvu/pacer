//! Candidate-free private adoption control. No public registration creates these capabilities.
use super::*;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionSource {
    pub target: super::super::wire::Installation,
    pub native_session_id: String,
    pub desktop_client_id: String,
    pub boot_id: String,
    pub desktop: ProcessIdentity,
    pub service: ProcessIdentity,
    pub service_version: String,
    pub old_service_executable: String,
    pub new_service_executable: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionRequestReceipt {
    pub request_id: String,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionContext {
    pub schema: u32,
    pub binding: super::super::wire::Binding,
    pub transaction_kind: String,
    pub source: AdoptionSource,
    pub service: ProcessIdentity,
    pub service_executable: String,
    pub service_version: String,
    pub protocol: u64,
    pub admission_protocol: u64,
    pub state_compatible: bool,
    pub request: AdoptionRequestReceipt,
    pub transaction: TransactionContext,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AdoptionBranch {
    Managed,
    Original,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionBranchPlan {
    pub branch: AdoptionBranch,
    pub launch_id: String,
    pub nonce: String,
    pub executable: String,
    pub version: String,
    pub installation_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionReconnectPlan {
    pub schema: u32,
    pub kind: String,
    pub installation_id: String,
    pub transaction_id: String,
    pub native_session_id: String,
    pub manifest_sha256: String,
    pub desktop: ProcessIdentity,
    pub recovery: bool,
    pub managed: Option<AdoptionBranchPlan>,
    pub original: AdoptionBranchPlan,
}
impl AdoptionReconnectPlan {
    pub fn validate(&self) -> Result<(), OtaError> {
        if self.schema != 1
            || self.kind != "adoption"
            || !identifier(&self.installation_id)
            || !identifier(&self.transaction_id)
            || !identifier(&self.native_session_id)
            || !valid_nonce(&self.manifest_sha256)
            || self.original.branch != AdoptionBranch::Original
            || self.desktop.pid == 0
            || self.desktop.boot_id.is_empty()
            || self.desktop.birth.is_empty()
            || self.original.installation_id != self.installation_id
            || self.recovery != self.managed.is_none()
        {
            return Err(OtaError::Invalid);
        }
        if self.managed.as_ref().is_some_and(|p| {
            p.branch != AdoptionBranch::Managed
                || p.launch_id == self.original.launch_id
                || p.installation_id == self.installation_id
        }) {
            return Err(OtaError::Invalid);
        }
        for branch in self.branches() {
            if !valid_nonce(&branch.launch_id)
                || branch.nonce != branch.launch_id
                || !identifier(&branch.installation_id)
                || !Path::new(&branch.executable).is_absolute()
                || branch.executable.contains('\0')
                || branch.executable.len() > 4096
                || branch
                    .executable
                    .split('/')
                    .any(|part| part == "." || part == "..")
                || semver::Version::parse(&branch.version).is_err()
            {
                return Err(OtaError::Invalid);
            }
        }
        Ok(())
    }
    pub fn branches(&self) -> impl Iterator<Item = &AdoptionBranchPlan> {
        self.managed.iter().chain(std::iter::once(&self.original))
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionReadinessProof {
    pub installation_id: String,
    pub transaction_id: String,
    pub resulting_installation_id: String,
    pub branch: AdoptionBranch,
    pub desktop: ProcessIdentity,
    pub native_session_id: String,
    pub desktop_version: String,
    pub service: ProcessIdentity,
    pub service_version: String,
    pub protocol: u64,
    pub desktop_signed_in: bool,
    pub valid_state_read: bool,
}
fn request<T: serde::de::DeserializeOwned>(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    trust: &ReleaseTrust,
    kind: &str,
    extra: serde_json::Value,
) -> Result<T, OtaError> {
    let (mut stream, session) = authenticate_service(endpoint, trust, "helper", None)?;
    let mut value = serde_json::json!({"schema":1,"kind":kind,"transactionKind":"adoption","sessionId":session.session_id,"sequence":1,"binding":binding});
    value
        .as_object_mut()
        .ok_or(OtaError::Invalid)?
        .extend(extra.as_object().ok_or(OtaError::Invalid)?.clone());
    write_frame(&mut stream, &value)?;
    read_frame(&mut stream)
}
pub fn adoption_context(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<AdoptionContext, OtaError> {
    let until = std::time::Instant::now() + HANDSHAKE_RETRY;
    // Only this read-only request may repeat after a lost reply. Mutating
    // requests retain their existing single-exchange behavior.
    deadline::retry(
        until,
        std::time::Instant::now,
        std::thread::sleep,
        |until| {
            let (mut stream, session) = authenticate_service_adoption_until(
                endpoint,
                trust,
                "helper",
                None,
                None,
                Some(until),
            )?;
            write_frame_until(
                &mut stream,
                &serde_json::json!({"schema":1,"kind":"adoption-context","transactionKind":"adoption","sessionId":session.session_id,"sequence":1,"binding":binding}),
                Some(until),
            )?;
            let context: AdoptionContext = read_frame_until(&mut stream, Some(until))?;
            if context.schema != 1
                || context.transaction_kind != "adoption"
                || context.binding != *binding
                || context.source.target.id != binding.installation_id
                || context.service != *endpoint.process
                || context.service_executable != endpoint.executable.to_string_lossy()
                || context.protocol != 3
                || context.admission_protocol != 1
                || !context.state_compatible
            {
                return Err(OtaError::Identity);
            }
            Ok(context)
        },
    )
}

pub fn prepare_adoption_reconnect(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    plan: &AdoptionReconnectPlan,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    plan.validate()?;
    let ack: ControlAck = request(
        endpoint,
        binding,
        trust,
        "adoption-reconnect",
        serde_json::json!({"plan":plan}),
    )?;
    if !ack.matches(binding, "adoption-reconnect") {
        return Err(OtaError::Identity);
    }
    Ok(())
}
pub fn observe_adoption_launch(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    branch: AdoptionBranch,
    trust: &ReleaseTrust,
) -> Result<Option<super::super::LaunchEvidence>, OtaError> {
    request(
        endpoint,
        binding,
        trust,
        "adoption-observe-launch",
        serde_json::json!({"branch":branch}),
    )
}
pub fn query_adoption_readiness(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    branch: AdoptionBranch,
    trust: &ReleaseTrust,
) -> Result<Option<AdoptionReadinessProof>, OtaError> {
    request(
        endpoint,
        binding,
        trust,
        "adoption-readiness",
        serde_json::json!({"branch":branch}),
    )
}
pub fn release_adoption(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    let ack: ControlAck = request(
        endpoint,
        binding,
        trust,
        "adoption-release",
        serde_json::json!({}),
    )?;
    if !ack.matches(binding, "adoption-release") {
        return Err(OtaError::Identity);
    }
    Ok(())
}

pub fn suppress_adoption_lifecycle(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    let ack: ControlAck = request(
        endpoint,
        binding,
        trust,
        "adoption-suppress",
        serde_json::json!({}),
    )?;
    if !ack.matches(binding, "adoption-suppress") {
        return Err(OtaError::Identity);
    }
    Ok(())
}
pub fn request_adoption_shutdown(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    expected: &ProcessIdentity,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    let ack: ControlAck = request(
        endpoint,
        binding,
        trust,
        "adoption-shutdown",
        serde_json::json!({"expected":expected}),
    )?;
    if !ack.matches(binding, "adoption-shutdown") {
        return Err(OtaError::Identity);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> AdoptionReconnectPlan {
        AdoptionReconnectPlan {
            schema: 1,
            kind: "adoption".into(),
            installation_id: "attached".into(),
            transaction_id: "transaction".into(),
            native_session_id: "original-native".into(),
            manifest_sha256: "a".repeat(64),
            desktop: ProcessIdentity {
                pid: 42,
                boot_id: "boot".into(),
                birth: "1:1".into(),
            },
            recovery: false,
            managed: Some(AdoptionBranchPlan {
                branch: AdoptionBranch::Managed,
                launch_id: "b".repeat(64),
                nonce: "b".repeat(64),
                executable: "/tmp/pacer.app/Contents/Resources/pacer".into(),
                version: "1.0.0".into(),
                installation_id: "managed".into(),
            }),
            original: AdoptionBranchPlan {
                branch: AdoptionBranch::Original,
                launch_id: "c".repeat(64),
                nonce: "c".repeat(64),
                executable: "/opt/pacer".into(),
                version: "1.0.0".into(),
                installation_id: "attached".into(),
            },
        }
    }
    #[test]
    fn adoption_plan_binds_distinct_branches_and_rejects_redirected_paths_or_processes() {
        let valid = plan();
        valid.validate().unwrap();
        let mut bad = valid.clone();
        bad.managed.as_mut().unwrap().nonce = bad.original.nonce.clone();
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.managed.as_mut().unwrap().executable = "/tmp/../other/pacer".into();
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.desktop.pid = 0;
        assert!(bad.validate().is_err());
        let mut bad = valid;
        bad.original.installation_id = "another".into();
        assert!(bad.validate().is_err());
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionRecoveryContext {
    pub desktop: ProcessIdentity,
    pub native_session_id: String,
    pub service: ProcessIdentity,
    pub service_executable: String,
    pub service_version: String,
    pub protocol: u64,
}
pub fn adoption_recovery_context(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<Option<AdoptionRecoveryContext>, OtaError> {
    let value: Option<AdoptionRecoveryContext> = request(
        endpoint,
        binding,
        trust,
        "adoption-recovery-context",
        serde_json::json!({}),
    )?;
    if value.as_ref().is_some_and(|v| {
        v.service != *endpoint.process
            || v.service_executable != endpoint.executable.to_string_lossy()
            || v.protocol != 3
            || !identifier(&v.native_session_id)
    }) {
        return Err(OtaError::Identity);
    }
    Ok(value)
}
