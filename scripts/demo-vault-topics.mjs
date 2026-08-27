/**
 * The subject matter behind the demo vault - titles only, no real notes.
 *
 * Split out of `demo-vault.mjs` because a vault that shows what the platform is for has to be
 * the size of a real one (the author's has ~830 pages across 18 domains), and that is a lot of
 * page titles. They are hand-written rather than generated: the TITLE is what a screenshot
 * actually shows - graph labels, library rows, citation chips - so it has to read like
 * something a person would keep notes on. The page BODIES are assembled from templates in the
 * generator; nobody screenshots a page body, and inventing 400 of them would be busywork.
 *
 * `weight` mirrors how a personal wiki really grows: one subject you are deep in, a handful you
 * dip into, and a long tail of one-afternoon detours. A flat distribution across domains looks
 * synthetic at a glance, which is exactly what these images must not look like.
 *
 * Everything here is textbook subject matter. No real person, organisation, product or source.
 */

/** Sources are named after the concepts they support - that is how ingested documents read. */
export const SOURCE_SUFFIXES = [
  '(review)', '(methods paper)', '(survey)', '(technical note)', '(analysis)',
  '(lecture notes)', '(handbook chapter)', '(benchmark study)', '(field guide)',
  '(retrospective)',
]

export const DOMAINS = {
  /* ---------------------------------------------------------------- the deep one (~290) */
  astronomy: {
    blurb: 'exoplanets, the instruments that find them, and the stars they orbit',
    tags: ['astronomy', 'exoplanet', 'spectroscopy', 'photometry', 'stellar-physics'],
    concepts: [
      // detection
      'Transit Photometry', 'Radial Velocity Method', 'Transit Depth', 'Limb Darkening',
      'Transit Timing Variations', 'Astrometric Detection', 'Direct Imaging',
      'Gravitational Microlensing', 'Pulsar Timing', 'Doppler Beaming',
      'Ellipsoidal Variation', 'Occultation Timing', 'Phase Curve', 'Secondary Eclipse',
      'Transit Duration', 'Impact Parameter', 'Detection Efficiency', 'False Positive Rate',
      'Blended Eclipsing Binary', 'Candidate Vetting Pipeline',
      // atmospheres
      'Atmospheric Transmission Spectroscopy', 'Emission Spectroscopy', 'Atmospheric Scale Height',
      'Rayleigh Scattering Slope', 'Cloud Deck', 'Photochemical Haze', 'Thermal Inversion',
      'Atmospheric Escape', 'Hydrodynamic Escape', 'Atmospheric Metallicity',
      'Carbon-to-Oxygen Ratio', 'Equilibrium Temperature', 'Bond Albedo',
      'Heat Redistribution', 'Terminator Asymmetry', 'Molecular Opacity',
      'Atmospheric Retrieval', 'Free Retrieval', 'Chemical Equilibrium Model',
      'Aerosol Scattering',
      // stellar physics
      'Stellar Activity Noise', 'Starspot Modulation', 'Faculae', 'Chromospheric Emission',
      'Stellar Rotation Period', 'Gyrochronology', 'Convective Blueshift', 'Granulation Noise',
      'Stellar Metallicity', 'Effective Temperature', 'Surface Gravity', 'Spectral Type',
      'Main Sequence Lifetime', 'Stellar Isochrone', 'Asteroseismology',
      'Solar-Like Oscillation', 'Magnetic Activity Cycle', 'Flare Rate', 'Stellar Wind',
      'Activity Index',
      // instrumentation
      'Spectral Resolution', 'Echelle Spectrograph', 'Wavelength Calibration',
      'Laser Frequency Comb', 'Fibre Scrambling', 'Adaptive Optics', 'Coronagraph', 'Starshade',
      'Point Spread Function', 'Detector Persistence', 'Charge Transfer Inefficiency',
      'Flat Fielding', 'Dark Current', 'Readout Noise', 'Pixel Response Non-Uniformity',
      'Guiding Jitter', 'Thermal Stability', 'Photometric Precision',
      // analysis
      'Light Curve Detrending', 'Systematics Removal', 'Gaussian Process Regression',
      'Markov Chain Monte Carlo', 'Nested Sampling', 'Posterior Distribution',
      'Bayesian Evidence', 'Model Comparison', 'Lomb-Scargle Periodogram',
      'Box Least Squares', 'Wavelet Denoising', 'Signal Averaging', 'Injection Recovery Test',
      'Bootstrap Uncertainty', 'Covariance Matrix', 'Prior Sensitivity',
      'Overfitting Diagnostics', 'Residual Correlation',
      // formation
      'Protoplanetary Disc', 'Core Accretion', 'Pebble Accretion', 'Gravitational Instability',
      'Snow Line', 'Disc Migration', 'Type I Migration', 'Resonance Capture',
      'Mean Motion Resonance', 'Planetesimal Formation', 'Streaming Instability', 'Dust Growth',
      'Disc Dispersal', 'Photoevaporation', 'Giant Impact', 'Debris Disc',
      // populations
      'Hot Jupiter', 'Warm Neptune', 'Super-Earth', 'Sub-Neptune', 'Radius Valley',
      'Occurrence Rate', 'Mass-Radius Relation', 'Bulk Density', 'Interior Structure Model',
      'Core Mass Fraction', 'Envelope Mass Fraction', 'Water World', 'Lava Planet',
      'Circumbinary Planet', 'Free-Floating Planet', 'Ultra-Short Period Planet',
      'Habitable Zone',
      // wider context
      'Parallax Measurement', 'Proper Motion', 'Galactic Kinematics', 'Stellar Population',
      'Initial Mass Function', 'Binary Fraction', 'Cluster Age Dating',
      'Interstellar Extinction', 'Distance Ladder', 'Standard Candle',
      'Spectral Energy Distribution', 'Bolometric Correction', 'Orbital Eccentricity',
      'Tidal Circularisation', 'Spin-Orbit Alignment', 'Rossiter-McLaughlin Effect',
      'Obliquity Measurement',
    ],
    entities: [
      'Space-Based Transit Survey', 'Ground-Based Spectrograph Network',
      'Infrared Space Observatory', 'Exoplanet Archive', 'Southern Sky Survey',
      'High-Resolution Spectrograph Consortium', 'Radial Velocity Working Group',
      'Transit Follow-Up Network', 'Adaptive Optics Testbed', 'Wide-Field Photometric Camera',
      'Space Astrometry Mission', 'Atmospheric Characterisation Programme',
      'Stellar Parameter Catalogue', 'Light Curve Archive', 'Detector Calibration Facility',
      'Observatory Time Allocation Committee', 'Photometric Standards Network',
      'Planet Candidate Vetting Group',
    ],
  },

  /* ------------------------------------------------------------------ the middle band */
  computing: {
    blurb: 'distributed systems, storage engines and the data structures under them',
    tags: ['computing', 'distributed-systems', 'algorithms', 'databases', 'concurrency'],
    concepts: [
      'Consensus Algorithm', 'Write-Ahead Log', 'Log-Structured Merge Tree', 'B-Tree Index',
      'Vector Clock', 'Eventual Consistency', 'Quorum Read', 'Idempotency Key', 'Backpressure',
      'Content-Addressed Storage', 'Bloom Filter', 'Copy-on-Write Snapshot', 'Chunking Strategy',
      'Inverted Index', 'Leader Election', 'Split Brain', 'Fencing Token', 'Lease Renewal',
      'Two-Phase Commit', 'Saga Pattern', 'Read Repair', 'Anti-Entropy', 'Merkle Tree',
      'Consistent Hashing', 'Rendezvous Hashing', 'Sharding Strategy', 'Hot Partition',
      'Compaction Policy', 'Tombstone', 'Write Amplification', 'Read Amplification',
      'Space Amplification', 'Page Cache', 'Direct IO', 'Fsync Barrier', 'Group Commit',
      'Multiversion Concurrency Control', 'Snapshot Isolation', 'Write Skew',
      'Serializable Isolation', 'Optimistic Locking', 'Deadlock Detection', 'Lock Escalation',
      'Connection Pooling', 'Circuit Breaker', 'Exponential Backoff', 'Jittered Retry',
      'Tail Latency', 'Head-of-Line Blocking', 'Queue Depth', 'Little\'s Law',
      'Load Shedding', 'Rate Limiter', 'Token Bucket', 'Cache Eviction Policy',
      'Cache Stampede', 'Negative Caching', 'Write-Through Cache', 'Materialised View',
      'Change Data Capture', 'Event Sourcing', 'Idempotent Consumer', 'Exactly-Once Delivery',
    ],
    entities: [
      'Embedded Key-Value Store', 'Distributed Log Service', 'Full-Text Search Library',
      'Coordination Service', 'Columnar Storage Format', 'Object Storage Backend',
      'Stream Processing Framework', 'Time-Series Database', 'Message Broker',
      'Service Mesh Sidecar', 'Container Scheduler', 'Consensus Library',
    ],
  },

  'climate-science': {
    blurb: 'the carbon cycle, ocean circulation and the proxy record',
    tags: ['climate', 'carbon-cycle', 'paleoclimate', 'ocean', 'modelling'],
    concepts: [
      'Carbon Cycle', 'Ocean Carbon Sink', 'Thermohaline Circulation', 'Ice Core Proxies',
      'Isotope Fractionation', 'Radiative Forcing', 'Climate Sensitivity', 'Feedback Loops',
      'Proxy Calibration', 'General Circulation Model', 'Ensemble Spread', 'Ocean Acidification',
      'Meridional Overturning', 'Sea Surface Temperature Record', 'Upwelling Zone',
      'Carbonate Compensation Depth', 'Alkalinity Budget', 'Biological Pump',
      'Solubility Pump', 'Permafrost Carbon', 'Methane Clathrate', 'Albedo Feedback',
      'Cloud Feedback', 'Water Vapour Feedback', 'Lapse Rate Feedback', 'Aerosol Forcing',
      'Volcanic Forcing', 'Solar Irradiance Variation', 'Milankovitch Cycles',
      'Dansgaard-Oeschger Event', 'Heinrich Event', 'Younger Dryas',
      'Paleocene-Eocene Thermal Maximum', 'Speleothem Record', 'Tree Ring Chronology',
      'Varve Counting', 'Radiocarbon Dating', 'Age-Depth Model', 'Detrital Correction',
      'Sea Level Reconstruction', 'Ice Sheet Mass Balance', 'Glacial Isostatic Adjustment',
      'Downscaling', 'Bias Correction', 'Emergent Constraint', 'Detection and Attribution',
    ],
    entities: [
      'Global Ocean Observing Array', 'Polar Ice Core Archive',
      'Climate Model Intercomparison Project', 'Paleoclimate Data Repository',
      'Ocean Time-Series Station', 'Atmospheric Monitoring Network',
      'Satellite Altimetry Mission', 'Regional Climate Modelling Group',
    ],
  },

  'machine-learning': {
    blurb: 'how models are trained, evaluated and made to behave',
    tags: ['machine-learning', 'training', 'evaluation', 'representation', 'optimisation'],
    concepts: [
      'Gradient Descent', 'Learning Rate Schedule', 'Batch Normalisation', 'Layer Normalisation',
      'Residual Connection', 'Attention Mechanism', 'Positional Encoding', 'Tokenisation',
      'Embedding Space', 'Cosine Similarity', 'Contrastive Loss', 'Cross-Entropy Loss',
      'Label Smoothing', 'Regularisation', 'Dropout', 'Weight Decay', 'Early Stopping',
      'Overfitting', 'Underfitting', 'Bias-Variance Trade-off', 'Train-Test Leakage',
      'Cross-Validation', 'Holdout Set', 'Distribution Shift', 'Covariate Shift',
      'Calibration Error', 'Confidence Interval', 'Precision and Recall', 'F1 Score',
      'ROC Curve', 'Confusion Matrix', 'Class Imbalance', 'Data Augmentation',
      'Transfer Learning', 'Fine-Tuning', 'Parameter-Efficient Adaptation', 'Knowledge Distillation',
      'Quantisation', 'Pruning', 'Mixture of Experts', 'Curriculum Learning',
      'Reinforcement Learning from Feedback', 'Reward Model', 'Policy Gradient',
      'Exploration-Exploitation', 'Retrieval-Augmented Generation', 'Context Window',
      'Prompt Sensitivity', 'Evaluation Harness', 'Benchmark Contamination',
      'Ablation Study', 'Scaling Law',
    ],
    entities: [
      'Open Model Weights Repository', 'Benchmark Suite', 'Annotation Platform',
      'Experiment Tracking Service', 'Vector Database', 'Model Card Registry',
      'Evaluation Working Group', 'Compute Cluster Allocation',
    ],
  },

  'materials-science': {
    blurb: 'structure, defects and why materials fail',
    tags: ['materials-science', 'crystallography', 'mechanics', 'characterisation', 'failure'],
    concepts: [
      'Crystal Lattice', 'Unit Cell', 'Miller Indices', 'Grain Boundary', 'Dislocation',
      'Burgers Vector', 'Slip System', 'Work Hardening', 'Recrystallisation', 'Annealing',
      'Phase Diagram', 'Eutectic Point', 'Solid Solution', 'Precipitation Hardening',
      'Martensitic Transformation', 'Diffusion Coefficient', 'Vacancy Migration',
      'Interstitial Defect', 'Stacking Fault', 'Twin Boundary', 'Yield Strength',
      'Ultimate Tensile Strength', 'Ductility', 'Fracture Toughness', 'Fatigue Life',
      'Crack Propagation', 'Stress Concentration', 'Creep Deformation', 'Stress Relaxation',
      'Elastic Modulus', 'Poisson Ratio', 'Anisotropy', 'Texture', 'Residual Stress',
      'Surface Roughness', 'Wear Mechanism', 'Corrosion Resistance', 'Passivation Layer',
      'Thermal Expansion Mismatch', 'Coating Adhesion',
    ],
    entities: [
      'Electron Microscopy Facility', 'X-Ray Diffraction Laboratory',
      'Mechanical Testing Standard', 'Materials Property Database',
      'Failure Analysis Working Group', 'Powder Diffraction File',
    ],
  },

  cooking: {
    blurb: 'technique, fermentation and why recipes work',
    tags: ['cooking', 'fermentation', 'baking', 'technique', 'food-science'],
    concepts: [
      'Maillard Reaction', 'Gluten Development', 'Sourdough Fermentation', 'Emulsification',
      'Brining', 'Starch Gelatinisation', 'Carryover Cooking', 'Autolyse', 'Lamination',
      'Acid Balance', 'Caramelisation', 'Denaturation', 'Coagulation', 'Enzymatic Browning',
      'Osmosis in Curing', 'Dry Aging', 'Sous Vide Equilibrium', 'Reverse Searing',
      'Fond and Deglazing', 'Reduction', 'Roux', 'Beurre Monté', 'Tempering Chocolate',
      'Sugar Stages', 'Crystallisation Control', 'Leavening Agents', 'Proofing Window',
      'Oven Spring', 'Steam Injection', 'Crumb Structure', 'Hydration Ratio',
      'Bulk Fermentation', 'Cold Retardation', 'Preferment', 'Lactic Acid Bacteria',
      'Wild Yeast Culture', 'Koji Cultivation', 'Umami Layering', 'Salt Percentage',
      'Mouthfeel',
    ],
    entities: [
      'Standard Kitchen Reference', 'Fermentation Culture Collection',
      'Regional Cookbook Archive', 'Ingredient Sourcing Guide', 'Baking Percentages Table',
    ],
  },

  neuroscience: {
    blurb: 'neurons, circuits and the methods used to watch them',
    tags: ['neuroscience', 'electrophysiology', 'imaging', 'plasticity', 'circuits'],
    concepts: [
      'Action Potential', 'Resting Membrane Potential', 'Ion Channel Gating', 'Synaptic Cleft',
      'Neurotransmitter Release', 'Receptor Desensitisation', 'Long-Term Potentiation',
      'Long-Term Depression', 'Synaptic Plasticity', 'Hebbian Learning', 'Dendritic Integration',
      'Axonal Conduction Velocity', 'Myelination', 'Refractory Period', 'Spike Train',
      'Firing Rate Coding', 'Temporal Coding', 'Population Vector', 'Receptive Field',
      'Lateral Inhibition', 'Central Pattern Generator', 'Neuromodulation',
      'Patch Clamp Recording', 'Multi-Electrode Array', 'Calcium Imaging', 'Optogenetics',
      'Functional Magnetic Resonance', 'Haemodynamic Response', 'Event-Related Potential',
      'Signal-to-Noise in Recording', 'Spike Sorting', 'Connectomics',
      'Blood-Brain Barrier', 'Glial Support', 'Critical Period',
    ],
    entities: [
      'Brain Atlas Project', 'Electrophysiology Rig', 'Imaging Core Facility',
      'Neural Data Repository', 'Animal Model Registry',
    ],
  },

  /* ------------------------------------------------------------------- the small ones */
  cryptography: {
    blurb: 'primitives, protocols and the assumptions under them',
    tags: ['cryptography', 'protocols', 'security', 'primitives'],
    concepts: [
      'Block Cipher', 'Stream Cipher', 'Mode of Operation', 'Authenticated Encryption',
      'Message Authentication Code', 'Cryptographic Hash Function', 'Collision Resistance',
      'Key Derivation Function', 'Salt and Pepper', 'Public Key Exchange',
      'Elliptic Curve Arithmetic', 'Digital Signature', 'Certificate Chain',
      'Forward Secrecy', 'Nonce Reuse', 'Side-Channel Leakage', 'Constant-Time Comparison',
      'Random Number Generation', 'Entropy Pool', 'Zero-Knowledge Proof',
    ],
    entities: ['Standards Body Specification', 'Reference Implementation Library', 'Test Vector Suite'],
  },

  economics: {
    blurb: 'markets, money and the way policy moves them',
    tags: ['economics', 'markets', 'monetary-policy', 'measurement'],
    concepts: [
      'Supply and Demand', 'Price Elasticity', 'Marginal Cost', 'Opportunity Cost',
      'Comparative Advantage', 'Market Failure', 'Externality', 'Public Good',
      'Information Asymmetry', 'Moral Hazard', 'Adverse Selection', 'Inflation Measurement',
      'Real versus Nominal', 'Interest Rate Transmission', 'Yield Curve',
      'Money Supply Aggregates', 'Velocity of Money', 'Fiscal Multiplier',
      'Purchasing Power Parity', 'Gini Coefficient',
    ],
    entities: ['National Statistics Office', 'Central Bank Research Bulletin', 'Household Survey Panel'],
  },

  photography: {
    blurb: 'optics, sensors and what a photograph physically is',
    tags: ['photography', 'optics', 'sensors', 'colour'],
    concepts: [
      'Depth of Field', 'Circle of Confusion', 'Diffraction Limit', 'Lens Aberration',
      'Vignetting', 'Chromatic Aberration', 'Sensor Quantum Efficiency', 'Dynamic Range',
      'Signal-to-Noise Ratio', 'Bayer Demosaicing', 'White Balance', 'Colour Gamut',
      'Tone Curve',
    ],
    entities: ['Colour Profile Standard', 'Lens Test Chart'],
  },

  linguistics: {
    blurb: 'how languages are structured and how they change',
    tags: ['linguistics', 'phonology', 'syntax', 'language-change'],
    concepts: [
      'Phoneme Inventory', 'Allophone', 'Minimal Pair', 'Morpheme', 'Derivational Morphology',
      'Syntactic Constituency', 'Dependency Grammar', 'Grammaticalisation', 'Sound Change',
      'Loanword Adaptation', 'Language Contact', 'Isogloss',
    ],
    entities: ['Language Documentation Archive', 'Comparative Corpus'],
  },

  'knowledge-management': {
    blurb: 'how the wiki itself is supposed to work',
    tags: ['knowledge-management', 'llm-wiki', 'method', 'retrieval', 'compounding'],
    concepts: [
      'LLM Wiki Pattern', 'Compounding Knowledge', 'Hot Cache', 'Atomic Note',
      'Knowledge Gap', 'Contextual Retrieval', 'Domain Registry', 'Orphan Page',
      'Link Density', 'Page Authority', 'Stub Threshold',
    ],
    entities: ['Wiki Skill Suite'],
  },

  'music-theory': {
    blurb: 'harmony, rhythm and tuning',
    tags: ['music-theory', 'harmony', 'tuning', 'rhythm'],
    concepts: [
      'Equal Temperament', 'Just Intonation', 'Harmonic Series', 'Voice Leading',
      'Functional Harmony', 'Modal Interchange', 'Polyrhythm',
    ],
    entities: ['Historical Tuning Table'],
  },

  'maritime-history': {
    blurb: 'navigation, trade routes and the ships that ran them',
    tags: ['maritime-history', 'navigation', 'trade', 'shipbuilding'],
    concepts: [
      'Dead Reckoning', 'Lunar Distance Method', 'Marine Chronometer', 'Trade Wind Route',
      'Hull Form Evolution', 'Cargo Manifest Practice', 'Port Quarantine',
    ],
    entities: ['Admiralty Chart Series'],
  },

  cartography: {
    blurb: 'projections, generalisation and what a map decides to omit',
    tags: ['cartography', 'projection', 'generalisation', 'geodesy'],
    concepts: [
      'Map Projection', 'Tissot Indicatrix', 'Geodetic Datum', 'Cartographic Generalisation',
      'Contour Interpolation', 'Label Placement',
    ],
    entities: ['National Mapping Agency Series'],
  },

  typography: {
    blurb: 'type, spacing and legibility',
    tags: ['typography', 'type-design', 'legibility', 'layout'],
    concepts: [
      'Optical Sizing', 'Kerning Pairs', 'Hinting', 'x-Height', 'Measure and Leading',
    ],
    entities: ['Type Specimen Archive'],
  },

  mycology: {
    blurb: 'fungi, their fruiting bodies and their substrates',
    tags: ['mycology', 'fungi', 'identification', 'ecology'],
    concepts: [
      'Spore Print', 'Mycelial Network', 'Mycorrhizal Association', 'Substrate Colonisation',
    ],
    entities: ['Regional Fungarium'],
  },
}

/** Pages linked from somewhere but never written - the backlog the graph surfaces. */
export const GAPS = [
  'Planetary Albedo', 'Stellar Jitter Budget', 'Telluric Correction', 'Barycentric Correction',
  'Limb Brightening', 'Disc Instability Criterion', 'Tidal Locking Timescale',
  'Carbonate Weathering Feedback', 'Meridional Heat Transport', 'Aerosol Indirect Effect',
  'Consistency Model', 'Merge Policy', 'Tombstone Compaction', 'Vector Quantisation',
  'Reward Hacking', 'Grokking', 'Slip Band Formation', 'Hydrogen Embrittlement',
  'Enzymatic Peeling', 'Retrogradation', 'Astrocyte Signalling', 'Dendritic Spine Turnover',
  'Post-Quantum Migration', 'Liquidity Trap', 'Anamorphic Squeeze', 'Vowel Shift Chain',
  'Retrieval Evaluation', 'Link Rot',
]

/** Cross-domain links: what makes the graph one object instead of eighteen islands. */
export const CROSS_LINKS = [
  ['Chunking Strategy', 'Contextual Retrieval'],
  ['Inverted Index', 'Contextual Retrieval'],
  ['Embedding Space', 'Contextual Retrieval'],
  ['Content-Addressed Storage', 'Knowledge Gap'],
  ['Bloom Filter', 'Hot Cache'],
  ['Markov Chain Monte Carlo', 'Ensemble Spread'],
  ['Gaussian Process Regression', 'Proxy Calibration'],
  ['Signal Averaging', 'Signal-to-Noise Ratio'],
  ['Isotope Fractionation', 'Spectral Resolution'],
  ['Bayesian Evidence', 'Model Comparison'],
  ['Cross-Validation', 'Injection Recovery Test'],
  ['Distribution Shift', 'Bias Correction'],
  ['Sensor Quantum Efficiency', 'Readout Noise'],
  ['Dynamic Range', 'Detector Persistence'],
  ['Crystal Lattice', 'Diffraction Limit'],
  ['Fatigue Life', 'Crack Propagation'],
  ['Lactic Acid Bacteria', 'Substrate Colonisation'],
  ['Mycorrhizal Association', 'Carbon Cycle'],
  ['Cryptographic Hash Function', 'Merkle Tree'],
  ['Random Number Generation', 'Entropy Pool'],
  ['Yield Curve', 'Interest Rate Transmission'],
  ['Atomic Note', 'Domain Registry'],
  ['Page Authority', 'Link Density'],
  ['Equal Temperament', 'Harmonic Series'],
  ['Map Projection', 'Geodetic Datum'],
  ['Dead Reckoning', 'Marine Chronometer'],
  ['Optical Sizing', 'x-Height'],
  ['Long-Term Potentiation', 'Hebbian Learning'],
  ['Attention Mechanism', 'Context Window'],
  ['Quantisation', 'Knowledge Distillation'],
]
