import chai, { expect } from "chai";
import { waffle, ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber } from "ethers";
import { deploy } from "./utils/contracts";

chai.use(solidity);

import {
    OriginationController,
    CallWhitelist,
    MockERC20,
    MockERC721,
    VaultFactory,
    AssetVault,
    PromissoryNote,
    LoanCore,
    ArcadeItemsVerifier,
    FeeController,
    ERC1271LenderMock,
    MockERC1271LenderCustom,
    MockERC1271LenderNaive,
    UnvaultedItemsVerifier,
    CollectionWideOfferVerifier,
    BaseURIDescriptor,
    MockSmartBorrower
} from "../typechain";
import { approve, mint, ZERO_ADDRESS } from "./utils/erc20";
import { mint as mint721 } from "./utils/erc721";
import { Borrower, ItemsPredicate, LoanTerms, SignatureItem, SignatureProperties } from "./utils/types";
import { createLoanTermsSignature, createLoanItemsSignature, createPermitSignature } from "./utils/eip712";
import { encodeSignatureItems, encodeItemCheck, initializeBundle } from "./utils/loans";

import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    WHITELIST_MANAGER_ROLE,
    BASE_URI,
    MIN_LOAN_PRINCIPAL,
    EIP712_VERSION
} from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    originationController: OriginationController;
    feeController: FeeController;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    vaultFactory: VaultFactory;
    vault: AssetVault;
    lenderPromissoryNote: PromissoryNote;
    borrowerPromissoryNote: PromissoryNote;
    loanCore: LoanCore;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

/**
 * Creates a vault instance using the vault factory
 */
const createVault = async (factory: VaultFactory, user: Signer): Promise<AssetVault> => {
    const tx = await factory.connect(user).initializeBundle(user.address);
    const receipt = await tx.wait();

    let vault: AssetVault | undefined;
    if (receipt && receipt.events) {
        for (const event of receipt.events) {
            if (event.args && event.args.vault) {
                vault = <AssetVault>await ethers.getContractAt("AssetVault", event.args.vault);
            }
        }
    } else {
        throw new Error("Unable to create new vault");
    }
    if (!vault) {
        throw new Error("Unable to create new vault");
    }
    return vault;
};

const fixture = async (): Promise<TestContext> => {
    const signers: Signer[] = await ethers.getSigners();
    const [deployer] = signers;

    const feeController = <FeeController>await deploy("FeeController", signers[0], []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz LenderNote", "aLN", descriptor.address]);

    const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

    // Grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(deployer).initialize(loanCore.address);
    }

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])

    const vault = await createVault(vaultFactory, signers[0]);

    const mockERC20 = <MockERC20>await deploy("MockERC20", deployer, ["Mock ERC20", "MOCK"]);
    const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);

    const originationController = <OriginationController>await deploy(
        "OriginationController", signers[0], [loanCore.address, feeController.address]
    )
    await originationController.deployed();

    // admin whitelists MockERC20 on OriginationController
    const whitelistCurrency = await originationController.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    await whitelistCurrency.wait();
    // verify the currency is whitelisted
    const isWhitelisted = await originationController.isAllowedCurrency(mockERC20.address);
    expect(isWhitelisted).to.be.true;

    // admin whitelists MockERC721 and vaultFactory on OriginationController
    await originationController.setAllowedCollateralAddresses(
        [mockERC721.address, vaultFactory.address],
        [true, true]
    );

    // verify the collateral is whitelisted
    const isCollateralWhitelisted = await originationController.isAllowedCollateral(mockERC721.address);
    expect(isCollateralWhitelisted).to.be.true;
    const isVaultFactoryWhitelisted = await originationController.isAllowedCollateral(vaultFactory.address);
    expect(isVaultFactoryWhitelisted).to.be.true;

    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        originationController,
        feeController,
        mockERC20,
        mockERC721,
        vaultFactory,
        vault,
        lenderPromissoryNote: lenderNote,
        borrowerPromissoryNote: borrowerNote,
        loanCore,
        user: deployer,
        other: signers[1],
        signers: signers.slice(2),
    };
};

const createLoanTermsExpired = (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(360000),
        principal = ethers.utils.parseEther("100"),
        interestRate = BigNumber.from(1),
        collateralId = "1",
        deadline = 808113600, // August 11, 1995
        affiliateCode = ethers.constants.HashZero
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
        collateralId,
        collateralAddress,
        payableCurrency,
        deadline,
        affiliateCode
    };
};

const createLoanTerms = (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(360000),
        principal = ethers.utils.parseEther("100"),
        interestRate = BigNumber.from(1),
        collateralId = "1",
        deadline = 1754884800,
        affiliateCode = ethers.constants.HashZero
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
        collateralId,
        collateralAddress,
        payableCurrency,
        deadline,
        affiliateCode
    };
};

const maxDeadline = ethers.constants.MaxUint256;
const emptyBuffer = Buffer.alloc(32);

const defaultSigProperties: SignatureProperties = {
    nonce: 1,
    maxUses: 1,
};

describe("OriginationController", () => {
    describe("constructor", () => {
        it("Reverts if loanCore address is not provided", async () => {
            const { feeController } = await loadFixture(fixture);

            const OriginationController = await ethers.getContractFactory("OriginationController");
            await expect(OriginationController.deploy(ZERO_ADDRESS, feeController.address)).to.be.revertedWith(
                `OC_ZeroAddress("loanCore")`
            );
        });

        it("Reverts if feeController address is not provided", async () => {
            const { loanCore } = await loadFixture(fixture);

            const OriginationController = await ethers.getContractFactory("OriginationController");
            await expect(OriginationController.deploy(loanCore.address, ZERO_ADDRESS)).to.be.revertedWith(
                `OC_ZeroAddress("feeController")`
            );
        });

        it("Instantiates the OriginationController", async () => {
            const { loanCore, feeController } = await loadFixture(fixture);

            const OriginationController = await ethers.getContractFactory("OriginationController");
            const originationController = await OriginationController.deploy(loanCore.address, feeController.address);
            await originationController.deployed();

            expect(originationController.address).to.not.be.undefined;
        });
    });

    describe("initializeLoan", () => {
        let ctx: TestContext;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { other: borrower } = ctx;

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("Reverts if msg.sender is neither lender or borrower and not approved", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    // some random guy
                    .connect(signers[3])
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("OC_CallerNotParticipant");
        });

        it("Reverts if wNFT not approved", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            // no approval of wNFT token

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("Reverts if principal not approved", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            // no approval of principal token
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
        });

        it("Reverts if principal below minimum allowable amount", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: BigNumber.from("999999"),
            });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("OC_PrincipalTooLow");
        });

        it("Reverts if interest rate too low", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(0) // 0 bps
            });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("OC_InterestRate");
        });

        it("Reverts if interest rate too high", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(100_000_001) // 1,000,000.01 bps
            });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("OC_InterestRate");
        });

        it("Reverts if approving own loan", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    // sender is the borrower, signer is also the borrower
                    .connect(borrower)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts if signer is not a participant", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            // signer is some random guy
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                signers[3],
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts when invalid nonce is passed on origination", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            let sigProperties: SignatureProperties = {
                nonce: 3,
                maxUses: 1,
            };

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                sigProperties, // Use nonce 3
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            sigProperties.nonce = 2; // Use nonce 2

            await expect(
                originationController
                    .connect(lender)
                    // Use nonce of 2, skipping nonce 1
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, sigProperties, []),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts on an expired signature", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTermsExpired(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
            });

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties, // Use nonce 3
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("OC_SignatureIsExpired");
        });

        it("Initializes a loan signed by the borrower", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("Initializes a loan signed by the lender", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("it does not allow a mismatch between signer and loan side", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;

            const [caller] = signers;
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
            });
            await mint(mockERC20, lender, loanTerms.principal);

            await originationController.connect(lender).approve(borrower.address, true);
            await originationController.connect(borrower).approve(caller.address, true);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(caller)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("SideMismatch");
        });

        it("Initializes a loan with unbundled collateral", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await mockERC721.connect(borrower).approve(originationController.address, tokenId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("does not allow a nonce to be re-used", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);

            // Successful loan - try to initialize loan again with same sig
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []),
            ).to.be.revertedWith("LC_NonceUsed");
        });
    });

    describe("initializeLoan with collateral permit", () => {
        let ctx: TestContext;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { other: borrower } = ctx;

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("Reverts if the collateral does not support permit", async () => {
            const {
                originationController,
                vaultFactory,
                user: lender,
                other: borrower,
                mockERC20,
                mockERC721
            } = ctx;

            const tokenId = await mint721(mockERC721, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            await mint(mockERC20, borrower, loanTerms.principal);

            // invalid signature because tokenId is something random here
            const permitData = {
                owner: borrower.address,
                spender: originationController.address,
                tokenId: 1234,
                nonce: 0,
                deadline: maxDeadline,
            };

            const collateralSig = await createPermitSignature(
                vaultFactory.address,
                await vaultFactory.name(),
                permitData,
                borrower,
            );

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithPermit(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        [],
                        collateralSig,
                        maxDeadline,
                    ),
            ).to.be.revertedWith("function selector was not recognized and there's no fallback function");
        });

        it("Reverts if vaultFactory.permit is invalid", async () => {
            const {
                originationController,
                vaultFactory,
                user: lender,
                other: borrower,
                mockERC20
            } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            // invalid signature because tokenId is something random here
            const permitData = {
                owner: borrower.address,
                spender: originationController.address,
                tokenId: 1234,
                nonce: 0,
                deadline: maxDeadline,
            };

            const collateralSig = await createPermitSignature(
                vaultFactory.address,
                await vaultFactory.name(),
                permitData,
                borrower,
            );

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithPermit(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        [],
                        collateralSig,
                        maxDeadline,
                    ),
            ).to.be.revertedWith("ERC721P_InvalidSignature");
        });

        it("Initializes a loan with permit", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const permitData = {
                owner: borrower.address,
                spender: originationController.address,
                tokenId: bundleId,
                nonce: 0,
                deadline: maxDeadline,
            };

            const collateralSig = await createPermitSignature(
                vaultFactory.address,
                await vaultFactory.name(),
                permitData,
                borrower,
            );

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithPermit(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        [],
                        collateralSig,
                        maxDeadline,
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });
    });

    describe("initializeLoan with items", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;
        let uvVerifier: UnvaultedItemsVerifier;
        let cwoVerifier: CollectionWideOfferVerifier;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { user, originationController, other: borrower } = ctx;

            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);
            uvVerifier = <ArcadeItemsVerifier>await deploy("UnvaultedItemsVerifier", user, []);
            cwoVerifier = <ArcadeItemsVerifier>await deploy("CollectionWideOfferVerifier", user, []);

            await originationController.connect(user).setAllowedVerifiers([
                verifier.address,
                uvVerifier.address,
                cwoVerifier.address
            ], [true, true, true]);

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("Reverts if the collateralAddress does not fit the vault factory interface", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).approve(originationController.address, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            ).to.be.revertedWith("function selector was not recognized and there's no fallback function");
        });

        it("Reverts if the required predicates fail", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const tokenId = await mint721(mockERC721, borrower);
            // Do not transfer erc721 to bundle
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            ).to.be.revertedWith("OC_PredicateFailed");
        });

        it("Reverts if the predicates array is empty", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;
            const bundleId = await initializeBundle(vaultFactory, borrower);
            await mint721(mockERC721, borrower);
            // Do not transfer erc721 to bundle
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

            const predicates: ItemsPredicate[] = [];

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts if the verifier contract is not approved", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;

            // Remove verifier approval
            await originationController.connect(lender).setAllowedVerifiers([verifier.address], [false]);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            ).to.be.revertedWith("OC_InvalidVerifier");
        });

        it("Initializes a loan on an unvaulted asset using an items signature", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);

            await mockERC721.connect(borrower).approve(originationController.address, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            const predicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC721.address, 0, true),
                }
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("Initializes a loan on an unvaulted asset using an items signature with a specific tokenId", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);

            await mockERC721.connect(borrower).approve(originationController.address, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            const predicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC721.address, tokenId, false),
                }
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("Unvaulted items signature reverts if address doesn't match", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);

            await mockERC721.connect(borrower).approve(originationController.address, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            const predicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC20.address, 0, true),
                }
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.be.revertedWith("OC_PredicateFailed");
        });

        it("Unvaulted items signature reverts if tokenId doesn't match", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);

            await mockERC721.connect(borrower).approve(originationController.address, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            const predicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC721.address, tokenId.mul(2), false),
                }
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.be.revertedWith("OC_PredicateFailed");
        });

        it("initializes an unvaulted loan with a CWO signature", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);

            await mockERC721.connect(borrower).approve(originationController.address, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            const predicates: ItemsPredicate[] = [
                {
                    verifier: cwoVerifier.address,
                    data: ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                }
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("initializes a vaulted loan with the same CWO signature", async () => {
            const { vaultFactory, originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const predicates: ItemsPredicate[] = [
                {
                    verifier: cwoVerifier.address,
                    data: ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                }
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });
    });

    describe("initializeLoan with collateral permit and items", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { user, originationController, other: borrower } = ctx;

            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await originationController.connect(user).setAllowedVerifiers([verifier.address], [true]);

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("Initializes a loan with permit and items", async () => {
            const {
                originationController,
                mockERC20,
                mockERC721,
                vaultFactory,
                user: lender,
                other: borrower,
            } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const permitData = {
                owner: borrower.address,
                spender: originationController.address,
                tokenId: bundleAddress,
                nonce: 0,
                deadline: maxDeadline,
            };

            const collateralSig = await createPermitSignature(
                vaultFactory.address,
                await vaultFactory.name(),
                permitData,
                borrower,
            );

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithPermit(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates,
                        collateralSig,
                        maxDeadline,
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("Reverts if vaultFactory.permit fails", async () => {
            const {
                originationController,
                vaultFactory,
                user: lender,
                other: borrower,
                mockERC20,
                mockERC721,
                borrowerPromissoryNote,
            } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            // invalid signature because tokenId is something random here
            const permitData = {
                owner: borrower.address,
                spender: originationController.address,
                tokenId: 1234,
                nonce: 0,
                deadline: maxDeadline,
            };

            const collateralSig = await createPermitSignature(
                vaultFactory.address,
                await vaultFactory.name(),
                permitData,
                borrower,
            );

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            const borrowerStructNotOwner: Borrower = {
                borrower: borrowerPromissoryNote.address, // not token owner
                callbackData: "0x"
            };

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithPermit(
                        loanTerms,
                        borrowerStructNotOwner,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates,
                        collateralSig,
                        maxDeadline,
                    ),
            ).to.be.revertedWith("ERC721P_NotTokenOwner");
        });

        it("Reverts if items predicate fails", async () => {
            const {
                originationController,
                vaultFactory,
                user: lender,
                other: borrower,
                mockERC20,
                mockERC721,
            } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const tokenId = await mint721(mockERC721, borrower);
            // Do not transfer erc721 to bundle
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            // valid signature
            const permitData = {
                owner: borrower.address,
                spender: originationController.address,
                tokenId: bundleId,
                nonce: 0,
                deadline: maxDeadline,
            };

            const collateralSig = await createPermitSignature(
                vaultFactory.address,
                await vaultFactory.name(),
                permitData,
                borrower,
            );

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithPermit(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates,
                        collateralSig,
                        maxDeadline,
                    ),
            ).to.be.revertedWith("OC_PredicateFailed");
        });
    });

    describe("verification whitelist", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;

        // TODO: Tests for changing whitelist manager role
        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", ctx.user, []);
        });

        it("does not allow a non-admin to update the whitelist", async () => {
            const { other, originationController } = ctx;

            await expect(
                originationController.connect(other).setAllowedVerifiers([verifier.address], [true]),
            ).to.be.revertedWith(`AccessControl`);
        });

        it("Try to set 0x0000 as address, should revert.", async () => {
            const { user, originationController } = ctx;

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifiers(["0x0000000000000000000000000000000000000000"], [true]),
            ).to.be.revertedWith(`OC_ZeroAddress("verifier")`);
        });

        it("allows the contract owner to update the whitelist", async () => {
            const { user, originationController } = ctx;

            await expect(originationController.connect(user).setAllowedVerifiers([verifier.address], [true]))
                .to.emit(originationController, "SetAllowedVerifier")
                .withArgs(verifier.address, true);

            expect(await originationController.isAllowedVerifier(verifier.address)).to.be.true;
        });

        it("does not allow a non-admin to perform a batch update", async () => {
            const { user, other, originationController } = ctx;

            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationController
                    .connect(other)
                    .setAllowedVerifiers([verifier.address, verifier2.address], [true, true]),
            ).to.be.revertedWith("AccessControl");
        });

        it("reverts if a batch update has zero elements", async () => {
            const { user, originationController } = ctx;

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifiers([], []),
            ).to.be.revertedWith("OC_ZeroArrayElements");
        });

        it("reverts if a batch update has too many elements", async () => {
            const { user, originationController } = ctx;

            const addresses: string[] = [];
            const bools: boolean[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(verifier.address);
                bools.push(true);
            }

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifiers(addresses, bools),
            ).to.be.revertedWith("OC_ArrayTooManyElements");
        });

        it("reverts if a batch update's arguments have mismatched length", async () => {
            const { user, originationController } = ctx;

            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifiers([verifier.address, verifier2.address], [true]),
            ).to.be.revertedWith("OC_BatchLengthMismatch");
        });

        it("allows the contract owner to perform a batch update", async () => {
            const { user, originationController } = ctx;

            await originationController.connect(user).setAllowedVerifiers([verifier.address], [true]);
            expect(await originationController.isAllowedVerifier(verifier.address)).to.be.true;

            // Deploy a new verifier, disable the first one
            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifiers([verifier.address, verifier2.address], [false, true]),
            )
                .to.emit(originationController, "SetAllowedVerifier")
                .withArgs(verifier.address, false)
                .to.emit(originationController, "SetAllowedVerifier")
                .withArgs(verifier2.address, true);

            expect(await originationController.isAllowedVerifier(verifier.address)).to.be.false;
            expect(await originationController.isAllowedVerifier(verifier2.address)).to.be.true;
        });

        it("only admin should be able to change whitelist manager", async () => {
            const { originationController, user, other } = ctx;

            await originationController.connect(user).grantRole(WHITELIST_MANAGER_ROLE, other.address);
            await originationController.connect(user).revokeRole(WHITELIST_MANAGER_ROLE, user.address);
            await expect(
                originationController.connect(other).grantRole(WHITELIST_MANAGER_ROLE, other.address),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    other.address
                ).toLowerCase()} is missing role ${ADMIN_ROLE}`,
            );
        });
    });

    describe("approvals", () => {
        let ctx: TestContext;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { other: borrower } = ctx;

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("reverts if trying to approve oneself", async () => {
            const { originationController, other: borrower } = ctx;

            await expect(originationController.connect(borrower).approve(borrower.address, true)).to.be.revertedWith(
                "OC_SelfApprove",
            );
        });

        it("allows the borrower to approve another signer", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newSigner] = signers;

            await expect(originationController.connect(borrower).approve(newSigner.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(borrower.address, newSigner.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                newSigner, // Now signed by a third party
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("allows the lender to approve another signer", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newSigner] = signers;

            await expect(originationController.connect(lender).approve(newSigner.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(lender.address, newSigner.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                newSigner, // Now signed by a third party
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("allows the borrower to approve another originator", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newOriginator] = signers;

            await expect(originationController.connect(borrower).approve(newOriginator.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(borrower.address, newOriginator.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(newOriginator)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("allows the lender to approve another originator", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newOriginator] = signers;

            await expect(originationController.connect(lender).approve(newOriginator.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(lender.address, newOriginator.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(newOriginator)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal);
        });

        it("does not allow unilateral borrower origination even if the lender approves", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            await expect(originationController.connect(lender).approve(borrower.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(lender.address, borrower.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("does not allow unilateral lender origination even if the borrower approves", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            await expect(originationController.connect(borrower).approve(lender.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(borrower.address, lender.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            ).to.be.revertedWith("OC_ApprovedOwnLoan");
        });

        describe("ERC-1271 lender", () => {
            it("honors an ERC-1271 approval", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <ERC1271LenderMock>await deploy("ERC1271LenderMock", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoan(
                            loanTerms,
                            borrowerStruct,
                            lenderContract.address,
                            sig,
                            defaultSigProperties,
                            []
                        ),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(lenderContract.address, originationController.address, loanTerms.principal)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(originationController.address, borrower.address, loanTerms.principal);
            });

            it("rejects an ERC-1271 approval, where signature has data appended and the lender is not aware", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <ERC1271LenderMock>await deploy("ERC1271LenderMock", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                    "0x00001234"
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoan(
                            loanTerms,
                            borrowerStruct,
                            lenderContract.address,
                            sig,
                            defaultSigProperties,
                            []
                        ),
                ).to.be.revertedWith("OC_InvalidSignature");
            });

            it("rejects an ERC-1271 approval if the contract does not return the magic value", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

                // Set borrower as the allowed signer
                const lenderContract = <ERC1271LenderMock>await deploy("ERC1271LenderMock", lender, [borrower.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoan(
                            loanTerms,
                            borrowerStruct,
                            lenderContract.address,
                            sig,
                            defaultSigProperties,
                            []
                        ),
                ).to.be.revertedWith("OC_InvalidSignature");
            });

            it("accepts an ERC1271 approval even if the lending contract is unaware of appended extra data", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <MockERC1271LenderNaive>await deploy("MockERC1271LenderNaive", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                    "0x00001234",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoan(
                            loanTerms,
                            borrowerStruct,
                            lenderContract.address,
                            sig,
                            defaultSigProperties,
                            []
                        ),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(lenderContract.address, originationController.address, loanTerms.principal)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(originationController.address, borrower.address, loanTerms.principal);
            });

            it("accepts an ERC1271 approval even if the lending contract is unaware (zero extra data)", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <MockERC1271LenderNaive>await deploy("MockERC1271LenderNaive", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoan(
                            loanTerms,
                            borrowerStruct,
                            lenderContract.address,
                            sig,
                            defaultSigProperties,
                            []
                        ),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(lenderContract.address, originationController.address, loanTerms.principal)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(originationController.address, borrower.address, loanTerms.principal);
            });

            it("honors an ERC-1271 approval where extra sig data is utilized", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <MockERC1271LenderCustom>await deploy("MockERC1271LenderCustom", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                    "0x00001234",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoan(
                            loanTerms,
                            borrowerStruct,
                            lenderContract.address,
                            sig,
                            defaultSigProperties,
                            []
                        ),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(lenderContract.address, originationController.address, loanTerms.principal)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(originationController.address, borrower.address, loanTerms.principal);
            });

            it("rejects an ERC-1271 approval with extra data if the contract does not return the magic value", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <MockERC1271LenderCustom>await deploy("MockERC1271LenderCustom", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                    "0x0000",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoan(
                            loanTerms,
                            borrowerStruct,
                            lenderContract.address,
                            sig,
                            defaultSigProperties,
                            []
                        ),
                ).to.be.revertedWith("OC_InvalidSignature");
            });

            it("accepts an 1271 approval using calldata, extra data present in calldata", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <ERC1271LenderMock>await deploy("ERC1271LenderMock", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                // get sig to use in calldata
                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                // calldata for loanTerms
                // ethers encode
                const calldata = ethers.utils.defaultAbiCoder.encode(
                    [ // types
                        "tuple(uint32, uint64, address, uint96, address, uint256, uint256, bytes32)", // loan terms
                        "tuple(address, bytes)", // borrower
                        "address", // lender
                        "tuple(uint8, bytes32, bytes32, bytes)", // signature
                        "uint160", // nonce
                        "uint96", // maxUses
                        "tuple(bytes, address)[]", // predicate array
                    ],
                    [ // values
                        [
                            loanTerms.interestRate,
                            loanTerms.durationSecs,
                            loanTerms.collateralAddress,
                            loanTerms.deadline,
                            loanTerms.payableCurrency,
                            loanTerms.principal,
                            loanTerms.collateralId,
                            loanTerms.affiliateCode
                        ],
                        [
                            borrower.address,
                            "0x"
                        ],
                        lenderContract.address,
                        [
                            sig.v,
                            sig.r,
                            sig.s,
                            "0x"
                        ],
                        1,
                        1,
                        [],
                    ]
                );

                // get initializeLoan function selector
                const initializeLoanSelector = originationController.interface.getSighash("initializeLoan");

                // append calldata to initializeLoan function selector
                const calldataWithSelector = initializeLoanSelector + calldata.slice(2);

                await expect(borrower.sendTransaction({
                    to: originationController.address,
                    data: calldataWithSelector
                }))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(lenderContract.address, originationController.address, loanTerms.principal)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(originationController.address, borrower.address, loanTerms.principal);
            });

            it("rejects an 1271 approval using calldata, extra data not present in calldata", async () => {
                // Deploy an ERC-1271 to act as the lender
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
                const lenderContract = <ERC1271LenderMock>await deploy("ERC1271LenderMock", lender, [lender.address]);

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

                await mint(mockERC20, lender, loanTerms.principal);
                await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
                await lenderContract.approve(mockERC20.address, originationController.address);

                // No approval for origination - OC will check ERC-1271

                // get sig to use in calldata
                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    lender,
                    EIP712_VERSION,
                    defaultSigProperties,
                    "l",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

                // calldata for loanTerms
                // ethers encode
                const calldata = ethers.utils.defaultAbiCoder.encode(
                    [ // types
                        "tuple(uint32, uint32, uint160, uint256, address, uint256, address, bytes32)", // loan terms
                        "tuple(address, bytes)", // borrower
                        "address", // lender
                        "tuple(uint8, bytes32, bytes32)", // signature, no extra data
                        "uint160", // nonce
                        "uint96", // maxUses
                        "tuple(bytes, address)[]", // predicate array
                    ],
                    [ // values
                        [
                            loanTerms.durationSecs,
                            loanTerms.deadline,
                            loanTerms.interestRate,
                            loanTerms.principal,
                            loanTerms.collateralAddress,
                            loanTerms.collateralId,
                            loanTerms.payableCurrency,
                            loanTerms.affiliateCode
                        ],
                        [
                            borrower.address,
                            "0x"
                        ],
                        lenderContract.address,
                        [
                            sig.v,
                            sig.r,
                            sig.s,
                            // no extra data
                        ],
                        1,
                        1,
                        [],
                    ]
                );

                // get initializeLoan function selector
                const initializeLoanSelector = originationController.interface.getSighash("initializeLoan");

                // append calldata to initializeLoan function selector
                const calldataWithSelector = initializeLoanSelector + calldata.slice(2);

                await expect(borrower.sendTransaction({
                    to: originationController.address,
                    data: calldataWithSelector
                })).to.be.revertedWith("function was called with incorrect parameters");
            });
        });
    });

    describe("Origination Fees", () => {
        let ctx: TestContext;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { other: borrower } = ctx;

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("Initializes a loan signed by the borrower, with 2% borrower origination fee", async () => {
            const { loanCore, originationController, feeController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            // Set a borrower origination fee
            await feeController.setLendingFee(await feeController.FL_01(), 2_00);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            const fee = BigNumber.from(loanTerms.principal).div(100).mul(2);
            const amountReceived = BigNumber.from(loanTerms.principal).div(100).mul(98);

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, amountReceived)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, loanCore.address, fee);

            expect(await mockERC20.balanceOf(lender.address)).to.equal(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(fee);
            expect(await mockERC20.balanceOf(borrower.address)).to.equal(amountReceived);
        });

        it("Initializes a loan signed by the borrower, with 2% lender origination fee", async () => {
            const { loanCore, originationController, feeController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const fee = BigNumber.from(loanTerms.principal).div(100).mul(2);
            const amountSent = BigNumber.from(loanTerms.principal).add(fee);

            await mint(mockERC20, lender, amountSent);

            // Set a lender origination fee
            await feeController.setLendingFee(await feeController.FL_02(), 2_00);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, amountSent);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, amountSent)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, loanCore.address, fee);

            expect(await mockERC20.balanceOf(lender.address)).to.equal(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(fee);
            expect(await mockERC20.balanceOf(borrower.address)).to.equal(loanTerms.principal);
        });

        it("Initializes a loan signed by the borrower, with 2% borrower AND lender origination fee", async () => {
            const { loanCore, originationController, feeController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const fee = BigNumber.from(loanTerms.principal).div(100).mul(2);
            const amountSent = BigNumber.from(loanTerms.principal).add(fee);
            const amountReceived = BigNumber.from(loanTerms.principal).sub(fee);

            await mint(mockERC20, lender, amountSent);

            // Set a borrower and lender origination fee
            await feeController.setLendingFee(await feeController.FL_01(), 2_00);
            await feeController.setLendingFee(await feeController.FL_02(), 2_00);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, amountSent);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, amountSent)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrower.address, amountReceived)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, loanCore.address, fee.mul(2));

            expect(await mockERC20.balanceOf(lender.address)).to.equal(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(fee.mul(2));
            expect(await mockERC20.balanceOf(borrower.address)).to.equal(amountReceived);
        });
    });

    describe("Collateral and currency whitelisting", () => {
        let ctx: TestContext;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { other: borrower } = ctx;

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("Reverts when using unapproved ERC20 for payable currency", async () => {
            const {
                originationController,
                mockERC721,
                vaultFactory,
                user: lender,
                other: borrower,
            } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            // another ERC20 token that is not approved for use
            const unapprovedERC20 = <MockERC20>await deploy("MockERC20", lender, ["Mock ERC20", "MOCK"]);

            const loanTerms = createLoanTerms(unapprovedERC20.address, vaultFactory.address, { collateralId: bundleId });

            await mint(unapprovedERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(unapprovedERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.be.revertedWith(`OC_InvalidCurrency("${unapprovedERC20.address}")`);
        });

        it("Reverts when using unapproved ERC721 for collateral", async () => {
            const { originationController, mockERC20, user: lender, other: borrower} = ctx;
            // another ERC721 token that is not approved for use
            const unapprovedERC721 = <MockERC721>await deploy("MockERC721", lender, ["Mock ERC721", "MOCK"]);

            const tokenId = await mint721(unapprovedERC721, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, unapprovedERC721.address, { collateralId: tokenId });

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await unapprovedERC721.connect(borrower).approve(originationController.address, tokenId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.be.revertedWith(`OC_InvalidCollateral("${unapprovedERC721.address}")`);
        });

        it("Reverts when whitelist manager role tries to whitelist a currency with no address provided", async () => {
            const { originationController, user: admin } = ctx;

            await expect(originationController.connect(admin).setAllowedPayableCurrencies([], []))
                .to.be.revertedWith("OC_ZeroArrayElements");
        });

        it("Reverts when whitelist manager role tries to whitelist more than 50 currencies", async () => {
            const { originationController, user: admin, mockERC20 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC20.address);
                bools.push({ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL });
            }

            await expect(originationController.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OC_ArrayTooManyElements");
        });

        it("Reverts when the currency whitelist batch update's arguments have mismatched length", async () => {
            const { originationController, user: admin, mockERC20 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 30; i++) addresses.push(mockERC20.address);
            for (let i = 0; i < 16; i++) bools.push({ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL });

            await expect(originationController.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OC_BatchLengthMismatch");
        });

        it("Reverts when user without whitelist manager role tries to whitelist a currency", async () => {
            const { originationController, other, mockERC20 } = ctx;

            await expect(originationController.connect(other).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]))
                .to.be.revertedWith("AccessControl");
        });

        it("Reverts when whitelist manager role tries to whitelist more than 50 collateral addresses", async () => {
            const { originationController, user: admin, mockERC721 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC721.address);
                bools.push({ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL });
            }

            await expect(originationController.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OC_ArrayTooManyElements");
        });

        it("Reverts when whitelist manager role tries to whitelist payable currency zero address", async () => {
            const { originationController, user: admin } = ctx;

            await expect(
                originationController.connect(admin).setAllowedPayableCurrencies([ZERO_ADDRESS], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]),
            ).to.be.revertedWith(`OC_ZeroAddress("token")`);
        });

        it("Reverts when whitelist manager role tries to remove a currency with no address provided", async () => {
            const { originationController, user: admin } = ctx;

            await expect(
                originationController.connect(admin).setAllowedPayableCurrencies([ZERO_ADDRESS], [{ isAllowed: false, minPrincipal: 0 }]),
            ).to.be.revertedWith(`OC_ZeroAddress("token")`);
        });

        it("Reverts when whitelist manager role tries to remove more than 50 currencies", async () => {
            const { originationController, user: admin, mockERC20 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC20.address);
                bools.push({ isAllowed: false, minPrincipal: 0 });
            }

            await expect(originationController.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OC_ArrayTooManyElements");
        });

        it("Reverts when user without whitelist manager role tries to remove a whitelisted currency", async () => {
            const { originationController,  other, mockERC20 } = ctx;

            await expect(originationController.connect(other).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: false, minPrincipal: 0 }]))
                .to.be.revertedWith("AccessControl");
        });

        it("Reverts when whitelist manager role tries to whitelist collateral with no address provided", async () => {
            const { originationController, user: admin } = ctx;

            await expect(originationController.connect(admin).setAllowedCollateralAddresses([], []))
                .to.be.revertedWith("OC_ZeroArrayElements");
        });

        it("Reverts when user without whitelist manager role tries to whitelist collateral", async () => {
            const { originationController, other, mockERC721 } = ctx;

            await expect(originationController.connect(other).setAllowedCollateralAddresses([mockERC721.address], [true]))
                .to.be.revertedWith("AccessControl");
        });

        it("Reverts when whitelist manager role tries to remove more than 50 collateral addresses", async () => {
            const { originationController, user: admin, mockERC721 } = ctx;

            const addresses: string[] = [];
            const bools: boolean[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC721.address);
                bools.push(false);
            }

            await expect(originationController.connect(admin).setAllowedCollateralAddresses(addresses, bools))
                .to.be.revertedWith("OC_ArrayTooManyElements");
        });

        it("Reverts when the collateral whitelist batch update's arguments have mismatched length", async () => {
            const { originationController, user: admin, mockERC721 } = ctx;

            const addresses: string[] = [];
            const bools: boolean[] = [];
            for (let i = 0; i < 30; i++) addresses.push(mockERC721.address);
            for (let i = 0; i < 16; i++) bools.push(true);

            await expect(originationController.connect(admin).setAllowedCollateralAddresses(addresses, bools))
                .to.be.revertedWith("OC_BatchLengthMismatch");
        });

        it("Reverts when user without whitelist manager role tries to remove a whitelisted currency", async () => {
            const { originationController, other, mockERC20 } = ctx;

            await expect(originationController.connect(other).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]))
                .to.be.revertedWith("AccessControl");
        });

        it("Whitelist manager role adds and removes whitelisted payable currency", async () => {
            const { originationController, user: admin, mockERC20 } = ctx;

            await expect(
                originationController.connect(admin).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }])
            ).to.emit(originationController, "SetAllowedCurrency").withArgs(mockERC20.address, true, MIN_LOAN_PRINCIPAL);

            expect(await originationController.isAllowedCurrency(mockERC20.address)).to.be.true;

            await expect(
                originationController.connect(admin).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: false, minPrincipal: 0 }])
            ).to.emit(originationController, "SetAllowedCurrency").withArgs(mockERC20.address, false, 0);

            expect(await originationController.isAllowedCurrency(mockERC20.address)).to.be.false;
        });

        it("Reverts when whitelist manager role tries to whitelist collateral at zero address", async () => {
            const { originationController, user: admin } = ctx;

            await expect(
                originationController.connect(admin).setAllowedCollateralAddresses([ZERO_ADDRESS], [true]),
            ).to.be.revertedWith(`OC_ZeroAddress("token")`);
        });

        it("Whitelist manager role adds and removes whitelisted collateral", async () => {
            const { originationController, user: admin, mockERC721 } = ctx;

            await expect(
                originationController.connect(admin).setAllowedCollateralAddresses([mockERC721.address], [true])
            ).to.emit(originationController, "SetAllowedCollateral").withArgs(mockERC721.address, true);

            expect(await originationController.isAllowedCollateral(mockERC721.address)).to.be.true;

            await expect(
                originationController.connect(admin).setAllowedCollateralAddresses([mockERC721.address], [false])
            ).to.emit(originationController, "SetAllowedCollateral").withArgs(mockERC721.address, false);

            expect(await originationController.isAllowedCollateral(mockERC721.address)).to.be.false;
        });

        it("Reverts when whitelist manager role tries to whitelist collateral at zero address", async () => {
            const { originationController, user: admin } = ctx;

            await expect(
                originationController.connect(admin).setAllowedCollateralAddresses([ZERO_ADDRESS], [false]),
            ).to.be.revertedWith(`OC_ZeroAddress("token")`);
        });
    });

    describe("Express borrow callback", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("Execute borrower callback", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, borrowerPromissoryNote } = ctx;

            // deploy MockSmartBorrower contract
            const borrowerContract = <MockSmartBorrower>await deploy("MockSmartBorrower", borrower, [originationController.address]);

            // create a bundle and send it to the borrower contract
            const bundleId = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).transferFrom(borrower.address, borrowerContract.address, bundleId);

            // MockSmartBorrower approves borrower to sign terms for them
            await borrowerContract.approveSigner(borrower.address, true);

            // borrower signs terms for the SmartBorrower contract
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            const callbackData = "0x1234";
            const borrowerStruct: Borrower = {
                borrower: borrowerContract.address,
                callbackData: callbackData
            };

            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await borrowerContract.approveERC721(vaultFactory.address, originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrowerContract.address, loanTerms.principal)
                .to.emit(borrowerContract, "OpExecuted");

            // expect borrower contract to be holder of the borrower note
            expect(await borrowerPromissoryNote.balanceOf(borrowerContract.address)).to.equal(1);
        });

        it("Cannot rollover same loan in callback", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, borrowerPromissoryNote } = ctx;

            // deploy MockSmartBorrower contract
            const borrowerContract = <MockSmartBorrower>await deploy("MockSmartBorrowerTest", borrower, [originationController.address]);

            // create a bundle and send it to the borrower contract
            const bundleId = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).transferFrom(borrower.address, borrowerContract.address, bundleId);

            // MockSmartBorrower approves borrower to sign terms for them
            await borrowerContract.approveSigner(borrower.address, true);

            // borrower signs terms for the SmartBorrower contract
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            // create callback data to rollover the new loanID that will be created
            const totalLoans = await borrowerPromissoryNote.totalSupply();
            const nextLoanId = totalLoans.add(1);
            const sigProperties: SignatureProperties = { nonce: 1, maxUses: 1 };
            const sigCallback = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );
            const callbackData = ethers.utils.defaultAbiCoder.encode(
                [ // types
                    "uint256", // oldLoanId
                    "tuple(uint32, uint64, address, uint96, address, uint256, uint256, bytes32)", // loan terms
                    "address", // lender
                    "tuple(uint8, bytes32, bytes32, bytes)", // signature
                    "uint160", // nonce
                    "uint96", // maxUses
                    "tuple(bytes, address)[]", // predicate array
                ],
                [ // values
                    nextLoanId,
                    [
                        loanTerms.interestRate,
                        loanTerms.durationSecs,
                        loanTerms.collateralAddress,
                        loanTerms.deadline,
                        loanTerms.payableCurrency,
                        loanTerms.principal,
                        loanTerms.collateralId,
                        loanTerms.affiliateCode
                    ],
                    lender.address,
                    [
                        sigCallback.v,
                        sigCallback.r,
                        sigCallback.s,
                        "0x"
                    ],
                    2,
                    1,
                    []
                ]
            );

            // get rolloverLoan function selector
            const rolloverLoanSelector = originationController.interface.getSighash("rolloverLoan");
            // append calldata to rolloverLoan function selector
            const calldataWithSelector = rolloverLoanSelector + callbackData.slice(2);

            const borrowerStruct: Borrower = {
                borrower: borrowerContract.address,
                callbackData: calldataWithSelector
            };

            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await borrowerContract.approveERC721(vaultFactory.address, originationController.address, bundleId);

            // reverts due to reentrancy guard which is triggered by the initializeLoan call
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    )
            ).to.be.revertedWith("MockSmartBorrowerRollover: Operation failed");
        });

        it("Start a loan and then try to rollover first loan in second loan callback", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, borrowerPromissoryNote } = ctx;

            // deploy MockSmartBorrower contract
            const borrowerContract = <MockSmartBorrower>await deploy("MockSmartBorrowerTest", borrower, [originationController.address]);

            // create a bundle and send it to the borrower contract
            const bundleId = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).transferFrom(borrower.address, borrowerContract.address, bundleId);

            // MockSmartBorrower approves borrower to sign terms for them
            await borrowerContract.approveSigner(borrower.address, true);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await borrowerContract.approveERC721(vaultFactory.address, originationController.address, bundleId);

            const borrowerStruct: Borrower = {
                borrower: borrowerContract.address,
                callbackData: "0x"
            };

            await originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, [])

            // lender signs rollover terms
            const sigProperties: SignatureProperties = { nonce: 2, maxUses: 1 };
            const sigCallback = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );
            // rollover callback data
            const callbackData = ethers.utils.defaultAbiCoder.encode(
                [ // types
                    "uint256", // oldLoanId
                    "tuple(uint32, uint64, address, uint96, address, uint256, uint256, bytes32)", // loan terms
                    "address", // lender
                    "tuple(uint8, bytes32, bytes32, bytes)", // signature
                    "uint160", // nonce
                    "uint96", // maxUses
                    "tuple(bytes, address)[]", // predicate array
                ],
                [ // values
                    1,
                    [
                        loanTerms.interestRate,
                        loanTerms.durationSecs,
                        loanTerms.collateralAddress,
                        loanTerms.deadline,
                        loanTerms.payableCurrency,
                        loanTerms.principal,
                        loanTerms.collateralId,
                        loanTerms.affiliateCode
                    ],
                    lender.address,
                    [
                        sigCallback.v,
                        sigCallback.r,
                        sigCallback.s,
                        "0x"
                    ],
                    2,
                    1,
                    []
                ]
            );

            // get rolloverLoan function selector
            const rolloverLoanSelector = originationController.interface.getSighash("rolloverLoan");
            // append calldata to rolloverLoan function selector
            const calldataWithSelector = rolloverLoanSelector + callbackData.slice(2);

            // create a second bundle and send it to the borrower contract
            const bundleId2 = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).transferFrom(borrower.address, borrowerContract.address, bundleId2);

            // borrower signs terms for the SmartBorrower contract to start the second loan
            const loanTerms2 = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId2 });
            const sig2 = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms2,
                borrower,
                EIP712_VERSION,
                sigProperties,
                "b",
            );

            await mint(mockERC20, lender, loanTerms2.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms2.principal);
            await borrowerContract.approveERC721(vaultFactory.address, originationController.address, bundleId2);

            const borrowerStruct2: Borrower = {
                borrower: borrowerContract.address,
                callbackData: calldataWithSelector
            };

            // reverts due to reentrancy guard which is triggered by the second initializeLoan call
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms2, borrowerStruct2, lender.address, sig2, sigProperties, [], { gasLimit: 10000000 })
            ).to.be.revertedWith("MockSmartBorrowerRollover: Operation failed");

            // expect borrower contract to be holder of just one borrower note
            expect(await borrowerPromissoryNote.balanceOf(borrowerContract.address)).to.equal(1);
        });

        it("Try to use another sig in callback to start loan with same collateral", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, borrowerPromissoryNote } = ctx;

            // deploy MockSmartBorrower contract
            const borrowerContract = <MockSmartBorrower>await deploy("MockSmartBorrowerTest", borrower, [originationController.address]);

            // create a bundle and send it to the borrower contract
            const bundleId = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).transferFrom(borrower.address, borrowerContract.address, bundleId);

            // MockSmartBorrower approves borrower to sign terms for them
            await borrowerContract.approveSigner(borrower.address, true);

            // borrower signs terms for the SmartBorrower contract
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            // create callback data to rollover the new loanID that will be created
            const sigCallback = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );
            const callbackData = ethers.utils.defaultAbiCoder.encode(
                [ // types
                    "tuple(uint32, uint64, address, uint96, address, uint256, uint256, bytes32)", // loan terms
                    "tuple(address, bytes)", // borrower
                    "address", // lender
                    "tuple(uint8, bytes32, bytes32, bytes)", // signature
                    "tuple(uint160, uint96)", // sig properties
                    "tuple(bytes, address)[]", // predicate array
                    "tuple(uint8, bytes32, bytes32, bytes)", // permit signature
                    "uint256" // permit deadline
                ],
                [ // values
                    [
                        loanTerms.interestRate,
                        loanTerms.durationSecs,
                        loanTerms.collateralAddress,
                        loanTerms.deadline,
                        loanTerms.payableCurrency,
                        loanTerms.principal,
                        loanTerms.collateralId,
                        loanTerms.affiliateCode
                    ],
                    [
                        borrowerContract.address,
                        "0x"
                    ],
                    lender.address,
                    [
                        sigCallback.v,
                        sigCallback.r,
                        sigCallback.s,
                        "0x"
                    ],
                    [defaultSigProperties.nonce, defaultSigProperties.maxUses],
                    [],
                    [
                        0,
                        emptyBuffer,
                        emptyBuffer,
                        "0x"
                    ],
                    0
                ]
            );

            // get rolloverLoan function selector
            const initializeLoanSelector = originationController.interface.getSighash("initializeLoan");
            // append calldata to rolloverLoan function selector
            const calldataWithSelector = initializeLoanSelector + callbackData.slice(2);

            const borrowerStruct: Borrower = {
                borrower: borrowerContract.address,
                callbackData: calldataWithSelector
            };

            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await borrowerContract.approveERC721(vaultFactory.address, originationController.address, bundleId);

            // _validateCounterparties fails since the signingCounter party is the lender.
            // Lender is not the signer of the terms and lender has not approved borrower to sign for them
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    )
            ).to.be.revertedWith("MockSmartBorrowerRollover: Operation failed");
        });

        it("Borrower contract starts loan, lender signs terms", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            // deploy MockSmartBorrower contract
            const borrowerContract = <MockSmartBorrower>await deploy("MockSmartBorrowerTest", borrower, [originationController.address]);

            // create a bundle and send it to the borrower contract
            const bundleId = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).transferFrom(borrower.address, borrowerContract.address, bundleId);

            // lender signs terms for the SmartBorrower contract
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            const borrowerStruct: Borrower = {
                borrower: borrowerContract.address,
                callbackData: "0x"
            };

            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await borrowerContract.approveERC721(vaultFactory.address, originationController.address, bundleId);

            await expect(
                borrowerContract
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    )
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, borrowerContract.address, loanTerms.principal)
        });

        it("Try to use second lender sig in callback, borrower contract starts loan", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, borrowerPromissoryNote } = ctx;

            // deploy MockSmartBorrower contract
            const borrowerContract = <MockSmartBorrower>await deploy("MockSmartBorrowerTest", borrower, [originationController.address]);

            // create a bundle and send it to the borrower contract
            const bundleId = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).transferFrom(borrower.address, borrowerContract.address, bundleId);

            // lender signs terms for the SmartBorrower contract
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // create callback data to initialize another loan with same asset
            const sigProperties: SignatureProperties = { nonce: 2, maxUses: 1 };
            const sigCallback = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );
            const callbackData = ethers.utils.defaultAbiCoder.encode(
                [ // types
                    "tuple(uint32, uint64, address, uint96, address, uint256, uint256, bytes32)", // loan terms
                    "tuple(address, bytes)", // borrower
                    "address", // lender
                    "tuple(uint8, bytes32, bytes32, bytes)", // signature
                    "uint160", // nonce
                    "uint96", // maxUses
                    "tuple(bytes, address)[]", // predicate array
                    "tuple(uint8, bytes32, bytes32, bytes)", // permit signature
                    "uint256" // permit deadline
                ],
                [ // values
                    [
                        loanTerms.interestRate,
                        loanTerms.durationSecs,
                        loanTerms.collateralAddress,
                        loanTerms.deadline,
                        loanTerms.payableCurrency,
                        loanTerms.principal,
                        loanTerms.collateralId,
                        loanTerms.affiliateCode
                    ],
                    [
                        borrowerContract.address,
                        "0x"
                    ],
                    lender.address,
                    [
                        sigCallback.v,
                        sigCallback.r,
                        sigCallback.s,
                        "0x"
                    ],
                    2,
                    1,
                    [],
                    [
                        0,
                        emptyBuffer,
                        emptyBuffer,
                        "0x"
                    ],
                    0
                ]
            );

            // get initializeLoan function selector
            const initializeLoanSelector = originationController.interface.getSighash("initializeLoan");
            // append calldata to initializeLoan function selector
            const calldataWithSelector = initializeLoanSelector + callbackData.slice(2);

            const borrowerStruct: Borrower = {
                borrower: borrowerContract.address,
                callbackData: calldataWithSelector
            };

            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await borrowerContract.approveERC721(vaultFactory.address, originationController.address, bundleId);

            // fails due to _initialize reentrancy guard
            await expect(
                borrowerContract
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    )
            ).to.be.revertedWith("MockSmartBorrowerRollover: Operation failed");
        });
    });
});
